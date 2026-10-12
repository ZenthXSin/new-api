import { apiError } from './store.mjs';

export function modelCredential(headers = {}) {
  const raw = headers['x-codex-model-config'];
  if (raw === undefined) return null;
  if (typeof raw !== 'string' || raw.length > 16384 || !/^[A-Za-z0-9+/=]+$/.test(raw)) throw apiError(400, 'invalid_model_credentials', 'Invalid model authorization');
  let value;
  try { value = JSON.parse(Buffer.from(raw, 'base64').toString('utf8')); } catch { throw apiError(400, 'invalid_model_credentials', 'Invalid model authorization'); }
  if (!value || typeof value.token !== 'string' || !/^nacx_[A-Za-z0-9_.-]{20,8192}$/.test(value.token) || typeof value.group !== 'string' || !value.group || value.group.length > 128 || /[\x00-\x1f\x7f]/.test(value.group) || typeof value.model !== 'string' || !/^[A-Za-z0-9_.:/-]{1,255}$/.test(value.model)) throw apiError(400, 'invalid_model_credentials', 'Invalid model authorization');
  return { token: value.token, group: value.group, model: value.model };
}
