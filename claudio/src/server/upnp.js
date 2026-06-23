// ============================================================
// upnp.js — UPnP 设备发现与音频投送
// SSDP M-SEARCH 扫描局域网 MediaRenderer，SOAP 控制播放
// ============================================================

import { createSocket } from 'dgram';
import http from 'http';
import { parseStringPromise } from 'xml2js';
import { request as httpRequest } from 'http';

// ---- SSDP 常量 ----

const SSDP_MULTICAST = '239.255.255.250';
const SSDP_PORT = 1900;
const SEARCH_TARGET = 'urn:schemas-upnp-org:device:MediaRenderer:1';
const MX = 3; // 最大等待响应秒数

// 已发现设备缓存
const discoveredDevices = new Map();

// ---- SSDP 设备扫描 ----

/**
 * 扫描局域网内的 UPnP MediaRenderer 设备。
 * 发送 SSDP M-SEARCH 广播，等待 MX 秒收集响应。
 *
 * @param {number} [timeout=3000] - 等待响应超时（毫秒）
 * @returns {Promise<Array<{name: string, location: string, uuid: string}>>}
 */
export async function scanDevices(timeout = 3000) {
  return new Promise((resolve) => {
    const devices = [];
    const socket = createSocket('udp4');
    let timer;

    const MESSAGE = [
      'M-SEARCH * HTTP/1.1',
      `HOST: ${SSDP_MULTICAST}:${SSDP_PORT}`,
      'MAN: "ssdp:discover"',
      `MX: ${MX}`,
      `ST: ${SEARCH_TARGET}`,
      '',
      ''
    ].join('\r\n');

    socket.on('message', (msg) => {
      const text = msg.toString();
      if (!text.includes(SEARCH_TARGET)) return;

      const location = (text.match(/LOCATION:\s*(.+)/i) || [])[1]?.trim();
      const usn = (text.match(/USN:\s*(.+)/i) || [])[1]?.trim();

      if (location && !devices.find(d => d.location === location)) {
        const device = {
          location,
          uuid: usn?.replace(/^uuid:/, '') || location,
          name: '未命名设备',
          status: 'discovered'
        };
        devices.push(device);

        // 异步获取设备详情
        getDeviceInfo(location).then(info => {
          device.name = info.friendlyName || device.name;
          device.manufacturer = info.manufacturer || '';
          device.modelName = info.modelName || '';
          discoveredDevices.set(device.uuid, device);
        }).catch(() => {});
      }
    });

    socket.on('listening', () => {
      socket.addMembership(SSDP_MULTICAST);
      socket.send(MESSAGE, SSDP_PORT, SSDP_MULTICAST);
    });

    timer = setTimeout(() => {
      socket.close();
      resolve(devices);
    }, timeout);

    socket.bind();
  });
}

// ---- 设备信息获取 ----

/**
 * 解析 UPnP 设备描述 XML，获取设备名等信息。
 * @param {string} location - 设备描述 XML URL
 * @returns {Promise<{friendlyName: string, manufacturer: string, modelName: string}>}
 */
async function getDeviceInfo(location) {
  return new Promise((resolve, reject) => {
    const url = new URL(location);

    const req = http.get(location, { timeout: 5000 }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', async () => {
        try {
          const parsed = await parseStringPromise(body);
          const device = parsed?.root?.device?.[0] || {};
          resolve({
            friendlyName: device.friendlyName?.[0] || '',
            manufacturer: device.manufacturer?.[0] || '',
            modelName: device.modelName?.[0] || ''
          });
        } catch {
          resolve({ friendlyName: '', manufacturer: '', modelName: '' });
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ---- SOAP 控制 ----

/**
 * 发送 UPnP SOAP 控制请求。
 * @param {string} url - 设备 control URL
 * @param {string} serviceType - 如 'urn:schemas-upnp-org:service:AVTransport:1'
 * @param {string} action - SOAP action 名称
 * @param {string} body - SOAP body XML
 */
function soapRequest(url, serviceType, action, body) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const soapBody = `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:${action} xmlns:u="${serviceType}">
      ${body}
    </u:${action}>
  </s:Body>
</s:Envelope>`;

    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || 80,
      path: urlObj.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset="utf-8"',
        'SOAPACTION': `"${serviceType}#${action}"`,
        'Content-Length': Buffer.byteLength(soapBody, 'utf-8')
      }
    };

    const req = httpRequest(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data);
        } else {
          reject(new Error(`SOAP error ${res.statusCode}: ${data.slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('SOAP timeout')); });
    req.write(soapBody);
    req.end();
  });
}

/**
 * 从设备描述 XML 中提取 AVTransport 和 RenderingControl 的 control URL。
 */
async function getServiceUrls(location) {
  return new Promise((resolve, reject) => {
    http.get(location, { timeout: 5000 }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', async () => {
        try {
          const parsed = await parseStringPromise(body);
          const services = parsed?.root?.device?.[0]?.serviceList?.[0]?.service || [];
          const urls = {};

          for (const svc of services) {
            const type = svc.serviceType?.[0] || '';
            if (type.includes('AVTransport')) {
              urls.avTransport = svc.controlURL?.[0];
            }
            if (type.includes('RenderingControl')) {
              urls.renderingControl = svc.controlURL?.[0];
            }
          }

          // 构建完整 URL
          const base = new URL(location);
          if (urls.avTransport) {
            urls.avTransport = new URL(urls.avTransport, `${base.protocol}//${base.host}`).href;
          }
          if (urls.renderingControl) {
            urls.renderingControl = new URL(urls.renderingControl, `${base.protocol}//${base.host}`).href;
          }

          resolve(urls);
        } catch {
          reject(new Error('Failed to parse device XML'));
        }
      });
    }).on('error', reject)
      .setTimeout(5000, function() { this.destroy(); reject(new Error('timeout')); });
  });
}

// ---- 投送 API ----

/**
 * 将音频 URL 投送到指定 UPnP 设备。
 *
 * @param {string} deviceLocation - 设备描述 XML 地址
 * @param {string} audioUrl - 音频流 URL（必须能被设备访问）
 * @param {object} [meta] - 媒体元信息
 * @returns {Promise<{success: boolean, device: string}>}
 */
export async function castToDevice(deviceLocation, audioUrl, meta = {}) {
  try {
    const urls = await getServiceUrls(deviceLocation);
    if (!urls.avTransport) {
      throw new Error('Device does not support AVTransport');
    }

    // 设置播放媒体 URI
    const metadata = meta.title
      ? `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/"><item><dc:title xmlns:dc="http://purl.org/dc/elements/1.1/">${meta.title}</dc:title></item></DIDL-Lite>`
      : '';

    await soapRequest(
      urls.avTransport,
      'urn:schemas-upnp-org:service:AVTransport:1',
      'SetAVTransportURI',
      `<InstanceID>0</InstanceID>
       <CurrentURI>${escapeXml(audioUrl)}</CurrentURI>
       <CurrentURIMetaData>${escapeXml(metadata)}</CurrentURIMetaData>`
    );

    // 开始播放
    await soapRequest(
      urls.avTransport,
      'urn:schemas-upnp-org:service:AVTransport:1',
      'Play',
      '<InstanceID>0</InstanceID><Speed>1</Speed>'
    );

    return { success: true, device: deviceLocation };
  } catch (err) {
    console.error('[UPnP] 投送失败:', err.message);
    return { success: false, device: deviceLocation, error: err.message };
  }
}

/**
 * 停止 UPnP 设备播放。
 */
export async function stopDevice(deviceLocation) {
  try {
    const urls = await getServiceUrls(deviceLocation);
    if (!urls.avTransport) return;

    await soapRequest(
      urls.avTransport,
      'urn:schemas-upnp-org:service:AVTransport:1',
      'Stop',
      '<InstanceID>0</InstanceID>'
    );
  } catch (err) {
    console.error('[UPnP] 停止失败:', err.message);
  }
}

/**
 * 暂停 UPnP 设备播放。
 */
export async function pauseDevice(deviceLocation) {
  try {
    const urls = await getServiceUrls(deviceLocation);
    if (!urls.avTransport) return;

    await soapRequest(
      urls.avTransport,
      'urn:schemas-upnp-org:service:AVTransport:1',
      'Pause',
      '<InstanceID>0</InstanceID>'
    );
  } catch (err) {
    console.error('[UPnP] 暂停失败:', err.message);
  }
}

/**
 * 设置 UPnP 设备音量。
 * @param {string} deviceLocation
 * @param {number} volume - 0-100
 */
export async function setDeviceVolume(deviceLocation, volume) {
  try {
    const urls = await getServiceUrls(deviceLocation);
    if (!urls.renderingControl) return;

    await soapRequest(
      urls.renderingControl,
      'urn:schemas-upnp-org:service:RenderingControl:1',
      'SetVolume',
      `<InstanceID>0</InstanceID>
       <Channel>Master</Channel>
       <DesiredVolume>${Math.round(volume)}</DesiredVolume>`
    );
  } catch (err) {
    console.error('[UPnP] 音量设置失败:', err.message);
  }
}

// ---- 工具 ----

function escapeXml(str) {
  return str.replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export default {
  scanDevices,
  castToDevice,
  stopDevice,
  pauseDevice,
  setDeviceVolume
};
