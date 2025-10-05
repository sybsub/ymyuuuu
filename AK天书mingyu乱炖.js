import { connect } from 'cloudflare:sockets';

let 哎呀呀这是我的VL密钥 = "00ebe2a7-e91e-40f9-b790-9fee953e2719";

let 启动控流机制 = false;
let 传输控流大小 = 64;

let 启用高级稳定性 = true;
let 心跳间隔 = 20000;
let Stall检测阈值 = 8000;
let 最大Stall次数 = 8;
let 最大重连次数 = 15;

export default {
  async fetch(访问请求) {
    if (访问请求.headers.get('Upgrade') === 'websocket'){
      const u = new URL(访问请求.url);
      if (u.pathname.includes('%3F')) {
        const decoded = decodeURIComponent(u.pathname);
        const queryIndex = decoded.indexOf('?');
        if (queryIndex !== -1) {
          u.search = decoded.substring(queryIndex);
          u.pathname = decoded.substring(0, queryIndex);
        }
      }
      
      const urlParams = u.searchParams;
      const mode = urlParams.get('mode') || 'auto';
      const s5Param = urlParams.get('s5');
      const proxyParam = urlParams.get('proxyip');
      const httpParam = urlParams.get('http');
      
      let socks5配置 = null;
      if (s5Param) {
        const 分隔账号 = s5Param.includes("@") ? s5Param.lastIndexOf("@") : -1;
        const 账号段 = s5Param.slice(0, 分隔账号);
        const 地址段 = 分隔账号 !== -1 ? s5Param.slice(分隔账号 + 1) : s5Param;
        const [账号, 密码] = 账号段 ? [账号段.slice(0, 账号段.lastIndexOf(":")), 账号段.slice(账号段.lastIndexOf(":") + 1)] : [null, null];
        const [地址, 端口] = 解析地址端口(地址段);
        socks5配置 = { 账号, 密码, 地址, 端口: +端口 };
      }
      
      let http代理配置 = null;
      if (httpParam) {
        const 分隔账号 = httpParam.includes("@") ? httpParam.lastIndexOf("@") : -1;
        const 账号段 = httpParam.slice(0, 分隔账号);
        const 地址段 = 分隔账号 !== -1 ? httpParam.slice(分隔账号 + 1) : httpParam;
        const [账号, 密码] = 账号段 ? [账号段.slice(0, 账号段.lastIndexOf(":")), 账号段.slice(账号段.lastIndexOf(":") + 1)] : [null, null];
        const [地址, 端口] = 解析地址端口(地址段);
        http代理配置 = { 账号, 密码, 地址, 端口: +端口 };
      }
      
      let proxyIP配置 = null;
      if (proxyParam) {
        const [地址, 端口] = 解析地址端口(proxyParam);
        proxyIP配置 = { 地址, 端口: +端口 || 443 };
      }
      
      const 连接顺序 = 获取连接顺序(mode, urlParams, socks5配置, proxyIP配置, http代理配置);
      
      const [客户端, WS接口] = Object.values(new WebSocketPair());
      WS接口.accept();
      启动传输管道(WS接口, null, 连接顺序, socks5配置, proxyIP配置, http代理配置);
      return new Response(null, { status: 101, webSocket: 客户端 });
    } else {
      return new Response('Hello World!', { status: 200 });
    }
  }
};

function 获取连接顺序(mode, urlParams, socks5配置, proxyIP配置, http代理配置) {
  if (mode !== 'auto') {
    return [mode];
  }
  
  const 顺序 = [];
  for (const [key] of urlParams) {
    if (key === 'direct' && !顺序.includes('direct')) 顺序.push('direct');
    else if (key === 's5' && socks5配置 && !顺序.includes('s5')) 顺序.push('s5');
    else if (key === 'proxyip' && proxyIP配置 && !顺序.includes('proxy')) 顺序.push('proxy');
    else if (key === 'http' && http代理配置 && !顺序.includes('http')) 顺序.push('http');
  }
  
  return 顺序.length ? 顺序 : ['direct'];
}

async function 启动传输管道(WS接口, TCP接口, 连接顺序, socks5配置, proxyIP配置, http代理配置) {
  let 识别地址类型, 访问地址, 地址长度, 首包数据 = false, 首包处理完成 = null, 传输数据, 读取数据;
  let isDNS = false, udpWriter = null;
  let 获取协议头 = 0;
  
  let 写入队列 = Promise.resolve();
  let 读取队列 = Promise.resolve();
  let 最后活动时间 = Date.now();
  let 最后数据接收时间 = Date.now();
  let stall计数 = 0;
  let 重连计数 = 0;
  let 心跳定时器 = null;
  let stall检测定时器 = null;
  let 连接信息 = null;
  let 正在重连 = false;
  let 累计传输字节数 = 0, 开始传输时间 = performance.now();

  function 清理资源() {
    if (心跳定时器) clearInterval(心跳定时器);
    if (stall检测定时器) clearInterval(stall检测定时器);
    心跳定时器 = null;
    stall检测定时器 = null;
  }

  function 启动心跳机制() {
    if (!启用高级稳定性 || isDNS) return;
    
    心跳定时器 = setInterval(async () => {
      if (正在重连 || !传输数据) return;
      
      const 空闲时间 = Date.now() - 最后活动时间;
      if (空闲时间 > 心跳间隔) {
        try {
          await 写入队列.then(async () => {
            if (传输数据 && !正在重连) {
              await 传输数据.write(new Uint8Array(0));
              最后活动时间 = Date.now();
            }
          });
        } catch (e) {}
      }
    }, 心跳间隔 / 2);
  }

  function 启动Stall检测() {
    if (!启用高级稳定性 || isDNS) return;
    
    stall检测定时器 = setInterval(() => {
      if (正在重连) return;
      
      const 无数据时间 = Date.now() - 最后数据接收时间;
      if (累计传输字节数 > 0 && 无数据时间 > Stall检测阈值) {
        stall计数++;
        if (stall计数 >= 最大Stall次数 && 重连计数 < 最大重连次数) {
          尝试安全重连();
        }
      }
    }, Stall检测阈值 / 2);
  }

  async function 尝试安全重连() {
    if (正在重连 || !连接信息 || WS接口.readyState !== 1 || isDNS) return;
    
    正在重连 = true;
    重连计数++;
    
    try {
      try { if (传输数据) { 传输数据.releaseLock(); 传输数据 = null; } } catch(e) {}
      try { if (读取数据) { 读取数据.releaseLock(); 读取数据 = null; } } catch(e) {}
      try { if (TCP接口) { TCP接口.close(); TCP接口 = null; } } catch(e) {}
      
      await new Promise(resolve => setTimeout(resolve, 500));
      
      let 新TCP接口;
      if (识别地址类型 === 3) {
        const 转换IPV6地址 = `[${访问地址}]`;
        新TCP接口 = connect({ hostname: 转换IPV6地址, port: 连接信息.端口 });
      } else {
        新TCP接口 = connect({ hostname: 连接信息.地址, port: 连接信息.端口 });
      }
      
      await 新TCP接口.opened;
      TCP接口 = 新TCP接口;
      传输数据 = TCP接口.writable.getWriter();
      读取数据 = TCP接口.readable.getReader();
      
      最后活动时间 = Date.now();
      最后数据接收时间 = Date.now();
      stall计数 = 0;
      正在重连 = false;
      
      启动回传管道();
      
    } catch (err) {
      正在重连 = false;
      if (重连计数 < 最大重连次数) {
        setTimeout(() => 尝试安全重连(), 1000);
      } else {
        WS接口.close();
      }
    }
  }

  function 更新活动状态() {
    最后活动时间 = Date.now();
  }

  function 更新数据接收() {
    最后数据接收时间 = Date.now();
    stall计数 = 0;
  }

  try {
    WS接口.addEventListener('message', async event => {
      更新活动状态();
      
      if (!首包数据) {
        首包数据 = true;
        首包处理完成 = 解析首包数据(event.data);
        await 写入队列.then(() => 首包处理完成);
        累计传输字节数 += event.data.length;
      } else {
        await 首包处理完成;
        if (isDNS) {
          await udpWriter.write(event.data);
        } else {
          const 当前数据 = event.data;
          写入队列 = 写入队列.then(async () => {
            if (传输数据 && !正在重连) {
              await 传输数据.write(当前数据);
            }
          });
        }
        累计传输字节数 += event.data.length;
      }
    });

    async function 解析首包数据(首包数据) {
      const 二进制数据 = new Uint8Array(首包数据);
      获取协议头 = 二进制数据[0];
      const 验证VL的密钥 = (a, i = 0) => [...a.slice(i, i + 16)].map(b => b.toString(16).padStart(2, '0')).join('').replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
      if (验证VL的密钥(二进制数据.slice(1, 17)) !== 哎呀呀这是我的VL密钥) throw new Error('UUID验证失败');
      const 提取端口索引 = 18 + 二进制数据[17] + 1;
      const 访问端口 = new DataView(二进制数据.buffer, 提取端口索引, 2).getUint16(0);
      
      if (访问端口 === 53) { 
        isDNS = true;
        let sent = false;
        const { readable, writable } = new TransformStream({
          transform(chunk, ctrl) {
            for (let i = 0; i < chunk.byteLength;) {
              const len = new DataView(chunk.slice(i, i + 2)).getUint16(0);
              ctrl.enqueue(chunk.slice(i + 2, i + 2 + len));
              i += 2 + len;
            }
          }
        });

        readable.pipeTo(new WritableStream({
          async write(query) {
            try {
              const resp = await fetch('https://1.1.1.1/dns-query', {
                method: 'POST',
                headers: { 'content-type': 'application/dns-message' },
                body: query
              });
              if (WS接口.readyState === 1) {
                const result = new Uint8Array(await resp.arrayBuffer());
                const 响应头 = new Uint8Array([获取协议头, 0]);
                WS接口.send(new Uint8Array([...(sent ? [] : 响应头), result.length >> 8, result.length & 0xff, ...result]));
                sent = true;
              }
            } catch (e) {}
          }
        }));
        udpWriter = writable.getWriter();
        
        const 提取地址索引 = 提取端口索引 + 2;
        识别地址类型 = 二进制数据[提取地址索引];
        let 地址信息索引 = 提取地址索引 + 1;
        
        switch (识别地址类型) {
          case 1:
            地址长度 = 4;
            访问地址 = 二进制数据.slice(地址信息索引, 地址信息索引 + 地址长度).join('.');
            break;
          case 2:
            地址长度 = 二进制数据[地址信息索引];
            地址信息索引 += 1;
            访问地址 = new TextDecoder().decode(二进制数据.slice(地址信息索引, 地址信息索引 + 地址长度));
            break;
          case 3:
            地址长度 = 16;
            const ipv6 = [];
            const 读取IPV6地址 = new DataView(二进制数据.buffer, 地址信息索引, 16);
            for (let i = 0; i < 8; i++) ipv6.push(读取IPV6地址.getUint16(i * 2).toString(16));
            访问地址 = ipv6.join(':');
            break;
          default:
            break;
        }
        
        const 初始DNS数据 = 二进制数据.slice(地址信息索引 + 地址长度);
        if (初始DNS数据.length > 0) {
          await udpWriter.write(初始DNS数据);
        }
        return;
      }
      
      const 提取地址索引 = 提取端口索引 + 2;
      识别地址类型 = 二进制数据[提取地址索引];
      let 地址信息索引 = 提取地址索引 + 1;
      switch (识别地址类型) {
        case 1:
          地址长度 = 4;
          访问地址 = 二进制数据.slice(地址信息索引, 地址信息索引 + 地址长度).join('.');
          break;
        case 2:
          地址长度 = 二进制数据[地址信息索引];
          地址信息索引 += 1;
          访问地址 = new TextDecoder().decode(二进制数据.slice(地址信息索引, 地址信息索引 + 地址长度));
          break;
        case 3:
          地址长度 = 16;
          const ipv6 = [];
          const 读取IPV6地址 = new DataView(二进制数据.buffer, 地址信息索引, 16);
          for (let i = 0; i < 8; i++) ipv6.push(读取IPV6地址.getUint16(i * 2).toString(16));
          访问地址 = ipv6.join(':');
          break;
        default:
          throw new Error ('无效的访问地址');
      }
      
      连接信息 = { 地址: 访问地址, 端口: 访问端口 };
      
      if (连接顺序 && 连接顺序.length > 0) {
        let 连接成功 = false;
        for (const 方式 of 连接顺序) {
          try {
            if (方式 === 'direct') {
              if (识别地址类型 === 3) {
                const 转换IPV6地址 = `[${访问地址}]`;
                TCP接口 = connect({ hostname: 转换IPV6地址, port: 访问端口 });
              } else {
                TCP接口 = connect({ hostname: 访问地址, port: 访问端口 });
              }
              await TCP接口.opened;
              连接成功 = true;
              break;
            } else if (方式 === 's5' && socks5配置) {
              TCP接口 = await 创建SOCKS5接口(识别地址类型, 访问地址, 访问端口, socks5配置);
              连接成功 = true;
              break;
            } else if (方式 === 'proxy' && proxyIP配置) {
              TCP接口 = connect({ hostname: proxyIP配置.地址, port: proxyIP配置.端口 });
              await TCP接口.opened;
              连接成功 = true;
              break;
            } else if (方式 === 'http' && http代理配置) {
              TCP接口 = await 创建HTTP代理接口(访问地址, 访问端口, http代理配置);
              连接成功 = true;
              break;
            }
          } catch (e) {
            continue;
          }
        }
        
        if (!连接成功) {
          throw new Error('所有连接方式都失败了');
        }
      } else {
        if (识别地址类型 === 3) {
          const 转换IPV6地址 = `[${访问地址}]`;
          TCP接口 = connect({ hostname: 转换IPV6地址, port: 访问端口 });
        } else {
          TCP接口 = connect({ hostname: 访问地址, port: 访问端口 });
        }
        await TCP接口.opened;
      }
      
      WS接口.send(new Uint8Array([获取协议头, 0]));
      
      传输数据 = TCP接口.writable.getWriter();
      读取数据 = TCP接口.readable.getReader();
      
      const 写入初始数据 = 二进制数据.slice(地址信息索引 + 地址长度);
      if (写入初始数据 && 写入初始数据.length > 0) {
        await 传输数据.write(写入初始数据);
      }
      
      setTimeout(() => {
        if (!isDNS) {
          启动心跳机制();
          启动Stall检测();
        }
        启动回传管道();
      }, 100);
    }
    
    async function 启动回传管道() {
      if (isDNS) return;
      
      try {
        while (true) {
          const { done: 流结束, value: 返回数据 } = await 读取数据.read();
          if (返回数据 && 返回数据.length > 0) {
            更新数据接收();
            
            const 当前数据 = 返回数据;
            读取队列 = 读取队列.then(() => {
              if (WS接口.readyState === 1 && !正在重连) {
                return WS接口.send(当前数据);
              }
            });
          }
          累计传输字节数 += 返回数据?.length || 0;
          if (流结束) break;
        }
      } catch (e) {}
    }
  } catch (e) {
    清理资源();
    try { if (TCP接口) await TCP接口.close(); } catch {};
    try { if (WS接口.readyState === 1) WS接口.close(); } catch {};
  }
  
  WS接口.addEventListener('close', 清理资源);
  WS接口.addEventListener('error', 清理资源);
}

async function 创建SOCKS5接口(识别地址类型, 访问地址, 访问端口, socks5配置 = null) {
  let SOCKS5接口, 账号, 密码, 地址, 端口;
  
  if (socks5配置) {
    账号 = socks5配置.账号;
    密码 = socks5配置.密码;
    地址 = socks5配置.地址;
    端口 = socks5配置.端口;
    
    try {
      SOCKS5接口 = connect({ hostname: 地址, port: 端口 });
      await SOCKS5接口.opened;
      return await 建立SOCKS5连接(SOCKS5接口, 识别地址类型, 访问地址, 访问端口, 账号, 密码);
    } catch (e) {
      throw new Error(`SOCKS5连接失败: ${e.message}`);
    }
  }
  
  throw new Error (`未提供SOCKS5配置`);
}

async function 建立SOCKS5连接(SOCKS5接口, 识别地址类型, 访问地址, 访问端口, 账号, 密码) {
  const 传输数据 = SOCKS5接口.writable.getWriter();
  const 读取数据 = SOCKS5接口.readable.getReader();
  const 转换数组 = new TextEncoder();
  
  const 构建S5认证 = new Uint8Array([5, 2, 0, 2]);
  await 传输数据.write(构建S5认证);
  const 读取认证要求 = (await 读取数据.read()).value;
  
  if (读取认证要求[1] === 0x02) {
    if (!账号 || !密码) {
      throw new Error (`SOCKS5服务器需要认证但未提供账号密码`);
    }
    const 构建账号密码包 = new Uint8Array([1, 账号.length, ...转换数组.encode(账号), 密码.length, ...转换数组.encode(密码)]);
    await 传输数据.write(构建账号密码包);
    const 读取账号密码认证结果 = (await 读取数据.read()).value;
    if (读取账号密码认证结果[0] !== 0x01 || 读取账号密码认证结果[1] !== 0x00) {
      throw new Error (`SOCKS5认证失败`);
    }
  } else if (读取认证要求[1] === 0x00) {
  } else {
    throw new Error (`不支持的SOCKS5认证方法: 0x${读取认证要求[1].toString(16)}`);
  }
  
  let 转换访问地址;
  switch (识别地址类型) {
    case 1:
      转换访问地址 = new Uint8Array([1, ...访问地址.split('.').map(Number)]);
      break;
    case 2:
      转换访问地址 = new Uint8Array([3, 访问地址.length, ...转换数组.encode(访问地址)]);
      break;
    case 3:
      转换访问地址 = 转换为Socks5IPv6地址(访问地址);
      break;
    default:
      throw new Error(`不支持的地址类型: ${识别地址类型}`);
  }
  
  const 构建转换后的访问地址 = new Uint8Array([5, 1, 0, ...转换访问地址, 访问端口 >> 8, 访问端口 & 0xff]);
  await 传输数据.write(构建转换后的访问地址);
  const 检查返回响应 = (await 读取数据.read()).value;
  
  if (检查返回响应[0] !== 0x05 || 检查返回响应[1] !== 0x00) {
    throw new Error (`SOCKS5连接失败，响应码: 0x${检查返回响应[1].toString(16)}`);
  }
  
  传输数据.releaseLock();
  读取数据.releaseLock();
  return SOCKS5接口;
}

async function 创建HTTP代理接口(目标地址, 目标端口, http代理配置) {
  const HTTP接口 = connect({ hostname: http代理配置.地址, port: http代理配置.端口 });
  await HTTP接口.opened;
  
  const 传输数据 = HTTP接口.writable.getWriter();
  const 读取数据 = HTTP接口.readable.getReader();
  
  let headers = `CONNECT ${目标地址}:${目标端口} HTTP/1.1\r\nHost: ${目标地址}:${目标端口}\r\n`;
  if (http代理配置.账号 && http代理配置.密码) {
    const token = btoa(`${http代理配置.账号}:${http代理配置.密码}`);
    headers += `Proxy-Authorization: Basic ${token}\r\n`;
  }
  headers += `\r\n`;
  
  await 传输数据.write(new TextEncoder().encode(headers));
  
  let response = "";
  while (true) {
    const { value, done } = await 读取数据.read();
    if (done) break;
    response += new TextDecoder().decode(value);
    if (response.includes("\r\n\r\n")) break;
  }
  
  if (!response.includes("200")) {
    throw new Error("HTTP代理连接失败");
  }
  
  传输数据.releaseLock();
  读取数据.releaseLock();
  return HTTP接口;
}

function 转换为Socks5IPv6地址(原始地址) {
  const 去括号地址 = 原始地址.startsWith('[') && 原始地址.endsWith(']')
    ? 原始地址.slice(1, -1)
    : 原始地址;
  const 分段 = 去括号地址.split('::');
  const 前缀 = 分段[0] ? 分段[0].split(':').filter(Boolean) : [];
  const 后缀 = 分段[1] ? 分段[1].split(':').filter(Boolean) : [];
  const 填充数量 = 8 - (前缀.length + 后缀.length);
  if (填充数量 < 0) throw new Error('IPv6地址格式错误');
  const 完整分段 = [...前缀, ...Array(填充数量).fill('0'), ...后缀];
  const IPv6字节 = 完整分段.flatMap(字段 => {
    const 数值 = parseInt(字段 || '0', 16);
    return [(数值 >> 8) & 0xff, 数值 & 0xff];
  });
  return new Uint8Array([0x04, ...IPv6字节]);
}

function 解析地址端口(地址段) {
  let 地址, IPV6地址, 端口;
  if (地址段.startsWith('[')) {
    [IPV6地址, 端口 = 443] = 地址段.slice(1, -1).split(']:');
    地址 = `[${IPV6地址}]`
  } else {
    [地址, 端口 = 443] = 地址段.split(':')
  }
  return [地址, 端口];
}

function 格式化字节(数据字节, 保留位数 = 2) {
  const 单位 = ['B', 'KB', 'MB', 'GB', 'TB'];
  let 指数 = 0;
  let 数值 = 数据字节;
  while (数值 >= 1024 && 指数 < 单位.length - 1) {
    数值 /= 1024;
    指数++;
  }
  return `${数值.toFixed(保留位数)} ${单位[指数]}`;
}

function 格式化时间(毫秒数) {
  const 总毫秒 = 毫秒数;
  const 小时 = Math.floor(总毫秒 / (3600 * 1000));
  const 分钟 = Math.floor((总毫秒 % (3600 * 1000)) / (60 * 1000));
  const 秒 = Math.floor((总毫秒 % (60 * 1000)) / 1000);
  const 毫秒 = 总毫秒 % 1000;
  return `${小时.toString().padStart(2, '0')}:${分钟.toString().padStart(2, '0')}:${秒.toString().padStart(2, '0')}.${毫秒.toString().padStart(3, '0')}`;
}