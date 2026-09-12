import { randomUUID } from 'node:crypto';
import { validateHeaderName, validateHeaderValue } from 'node:http';

const methods = ['ANY', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
export function validateRule(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('A rule must be an object.');
  const { name, pattern, method = 'ANY', match = 'contains', status = 200, delay = 0, body = '', headers = {}, enabled = true } = input;
  if (typeof name !== 'string' || !name.trim() || name.length > 100) throw new Error('Give the rule a name (up to 100 characters).');
  if (typeof pattern !== 'string' || !pattern.trim() || pattern.length > 2000) throw new Error('Enter a URL pattern (up to 2,000 characters).');
  if (!methods.includes(method)) throw new Error('Invalid HTTP method.');
  if (!['exact', 'contains', 'glob'].includes(match)) throw new Error('Invalid match type.');
  if (!Number.isInteger(status) || status < 200 || status > 599) throw new Error('Status must be between 200 and 599.');
  if (!Number.isInteger(delay) || delay < 0 || delay > 30000) throw new Error('Delay must be between 0 and 30,000 ms.');
  if (typeof body !== 'string' || Buffer.byteLength(body) > 1024 * 1024) throw new Error('Response body must be text, at most 1 MB.');
  if (typeof enabled !== 'boolean') throw new Error('Enabled must be true or false.');
  if (!headers || Array.isArray(headers) || typeof headers !== 'object' || Object.keys(headers).length > 100) throw new Error('Headers must be a JSON object with at most 100 entries.');
  const normalizedHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    validateHeaderName(key);
    if (typeof value !== 'string') throw new Error('Header values must be strings.');
    validateHeaderValue(key, value);
    if (['content-length', 'transfer-encoding', 'connection', 'content-encoding', 'upgrade', 'trailer'].includes(key.toLowerCase())) throw new Error(`Do not set ${key}; transport headers are managed automatically.`);
    normalizedHeaders[key.toLowerCase()] = value;
  }
  return { id: typeof input.id === 'string' && /^[\w-]{1,80}$/.test(input.id) ? input.id : randomUUID(), name: name.trim(), pattern: pattern.trim(), method, match, status, delay, body, headers: normalizedHeaders, enabled };
}
// Wildcard matching: only * is special. Avoid user-supplied regular expressions.
export function globMatch(text, pattern) {
  let t = 0, p = 0, star = -1, checkpoint = 0;
  while (t < text.length) {
    if (pattern[p] === '*') { star = p++; checkpoint = t; }
    else if (p < pattern.length && pattern[p] === text[t]) { p++; t++; }
    else if (star !== -1) { p = star + 1; t = ++checkpoint; }
    else return false;
  }
  while (pattern[p] === '*') p++;
  return p === pattern.length;
}
export function matches(rule, request) {
  if (!rule.enabled || (rule.method !== 'ANY' && rule.method !== request.method)) return false;
  if (rule.match === 'exact') return request.url === rule.pattern;
  if (rule.match === 'glob') return globMatch(request.url, rule.pattern);
  return request.url.includes(rule.pattern);
}
