const crypto = require('crypto');

// 1. CRC32C Castagnoli Implementation
const CASTAGNOLI_POLY = 0x82F63B78;
const crcTable = new Int32Array(256);
for (let i = 0; i < 256; i++) {
  let crc = i;
  for (let j = 0; j < 8; j++) {
    if (crc & 1) {
      crc = (crc >>> 1) ^ CASTAGNOLI_POLY;
    } else {
      crc = crc >>> 1;
    }
  }
  crcTable[i] = crc;
}

function calculateCrc32c(buffer) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buffer.length; i++) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ buffer[i]) & 0xFF];
  }
  return ((crc ^ 0xFFFFFFFF) >>> 0).toString(16).padStart(8, '0');
}

// 2. Date Validation & Normalization
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(y) {
  return (y % 4 === 0 && y % 100 !== 0) || (y % 400 === 0);
}

function parseAndNormalizeDate(dateStr) {
  if (typeof dateStr !== 'string') return null;
  const match = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-](\d{2}):(\d{2}))$/);
  if (!match) return null;
  
  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);
  const day = parseInt(match[3], 10);
  const hour = parseInt(match[4], 10);
  const minute = parseInt(match[5], 10);
  const second = parseInt(match[6], 10);
  const frac = match[7] || "";
  const ms = frac ? parseInt(frac.padEnd(3, '0'), 10) : 0;
  
  if (month < 1 || month > 12) return null;
  
  let maxDays = MONTH_DAYS[month - 1];
  if (month === 2 && isLeapYear(year)) {
    maxDays = 29;
  }
  if (day < 1 || day > maxDays) return null;
  if (hour < 0 || hour > 23) return null;
  if (minute < 0 || minute > 59) return null;
  if (second < 0 || second > 59) return null;
  
  const tz = match[8];
  let offsetMinutes = 0;
  if (tz !== 'Z') {
    const tzSign = tz[0] === '+' ? 1 : -1;
    const tzHours = parseInt(match[9], 10);
    const tzMins = parseInt(match[10], 10);
    if (tzHours < 0 || tzHours > 14) return null;
    if (tzMins < 0 || tzMins > 59) return null;
    if (tzHours === 14 && tzMins !== 0) return null;
    offsetMinutes = tzSign * (tzHours * 60 + tzMins);
  }
  
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, ms);
  let totalMs = date.getTime();
  if (isNaN(totalMs)) return null;
  
  totalMs -= offsetMinutes * 60 * 1000;
  
  const normDate = new Date(totalMs);
  const y = normDate.getUTCFullYear();
  const m = String(normDate.getUTCMonth() + 1).padStart(2, '0');
  const d = String(normDate.getUTCDate()).padStart(2, '0');
  const h = String(normDate.getUTCHours()).padStart(2, '0');
  const min = String(normDate.getUTCMinutes()).padStart(2, '0');
  const s = String(normDate.getUTCSeconds()).padStart(2, '0');
  const milli = String(normDate.getUTCMilliseconds()).padStart(3, '0');
  
  const yStr = String(y).padStart(4, '0');
  return `${yStr}-${m}-${d}T${h}:${min}:${s}.${milli}Z`;
}

// 3. Unicode Canonicalization
function canonicalizeText(str) {
  if (typeof str !== 'string') return "";
  let nfkc = str.normalize('NFKC');
  let lower = nfkc.toLowerCase();
  let trimmed = lower.trim();
  let collapsed = trimmed.replace(/[\s\p{White_Space}]+/gu, ' ');
  return collapsed;
}

// 4. Jaccard Similarity Word-Set Tokenizer
function getWordSet(text) {
  const words = text.match(/[\p{L}\p{N}]+/gu);
  if (!words) return new Set();
  return new Set(words);
}

function calculateJaccardSimilarity(setA, setB) {
  if (setA.size === 0 && setB.size === 0) return 1.0;
  
  let intersectionCount = 0;
  for (const item of setA) {
    if (setB.has(item)) {
      intersectionCount++;
    }
  }
  const unionCount = setA.size + setB.size - intersectionCount;
  if (unionCount === 0) return 1.0;
  return intersectionCount / unionCount;
}

module.exports = {
  calculateCrc32c,
  parseAndNormalizeDate,
  canonicalizeText,
  getWordSet,
  calculateJaccardSimilarity
};
