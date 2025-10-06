import crypto from 'crypto';

/**
 * Build MEXC Futures headers (private endpoints).
 * @param {string} apiKey
 * @param {string} apiSecret
 * @param {object|null} paramsOrBody  - For GET/DELETE: object of query params (sorted); For POST: raw JSON string
 * @param {('GET'|'POST'|'DELETE')} method
 * @returns {{headers: Record<string,string>, reqTime: string, signature: string, bodyString?: string, queryString?: string}}
 */
export function buildSignedHeaders(apiKey, apiSecret, paramsOrBody, method='GET'){
  const reqTime = Date.now().toString();
  let paramString = "";
  if (method === 'POST'){
    // For POST: signature parameter is JSON string
    if (paramsOrBody == null) {
      paramString = "";
    } else if (typeof paramsOrBody === 'string'){
      paramString = paramsOrBody;
    } else {
      paramString = JSON.stringify(paramsOrBody);
    }
  } else {
    // GET/DELETE: dictionary-sorted key=value&... (url-encoded values)
    const entries = Object.entries(paramsOrBody || {}).map(([k,v]) => [k, v==null? "": String(v)]);
    entries.sort((a,b)=> a[0].localeCompare(b[0]));
    paramString = entries.map(([k,v])=> `${k}=${encodeURIComponent(v).replace(/\+/g, '%20')}`).join('&');
  }
  const toSign = `${apiKey}${reqTime}${paramString}`;
  const signature = crypto.createHmac('sha256', apiSecret).update(toSign).digest('hex');
  const headers = {
    'ApiKey': apiKey,
    'Request-Time': reqTime,
    'Signature': signature,
    'Content-Type': 'application/json',
    'Recv-Window': '60000'
  };
  const out = { headers, reqTime, signature };
  if (method === 'POST') out.bodyString = paramString;
  else out.queryString = paramString;
  return out;
}
