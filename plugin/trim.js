(function (root) {
  function formatTime(seconds) {
    const total = Math.floor(Math.max(0, Number(seconds) || 0) + 0.5);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const rest = total % 60;
    return hours > 0
      ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
      : `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
  }

  function parseTime(input) {
    const value = String(input ?? '').trim();
    if (!value) return NaN;
    if (!value.includes(':')) return Number(value);
    const parts = value.split(':');
    if (parts.length < 2 || parts.length > 3 || parts.some((part) => part === '' || !/^\d+(?:\.\d+)?$/.test(part))) return NaN;
    const numbers = parts.map(Number);
    if (numbers.length === 2) return numbers[0] * 60 + numbers[1];
    return numbers[0] * 3600 + numbers[1] * 60 + numbers[2];
  }

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function normalizeRange(start, end, duration, minimumGap = 1 / 60) {
    const total = Math.max(0, Number(duration) || 0);
    if (total <= 0) return { start: 0, end: 0 };
    let begin = clamp(Number(start) || 0, 0, total);
    let finish = clamp(Number(end) || 0, 0, total);
    const gap = Math.min(minimumGap, total);
    if (finish - begin < gap) {
      if (begin + gap <= total) finish = begin + gap;
      else begin = Math.max(0, finish - gap);
    }
    return { start: begin, end: finish };
  }

  const api = { formatTime, parseTime, clamp, normalizeRange };
  root.LocalStreamTrim = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
