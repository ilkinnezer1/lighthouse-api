const ADJECTIVES = [
  'mighty',
  'crisp',
  'gentle',
  'nimble',
  'cosmic',
  'dapper',
  'eager',
  'fancy',
  'gleaming',
  'humble',
  'jolly',
  'kind',
  'lively',
  'merry',
  'noble',
  'plucky',
  'quiet',
  'rapid',
  'silver',
  'tidy',
  'vivid',
  'witty',
  'zesty',
  'amber',
  'bold',
  'clever',
  'dusky',
  'electric',
];

const NOUNS = [
  'otter',
  'fern',
  'comet',
  'finch',
  'maple',
  'pebble',
  'quartz',
  'river',
  'spruce',
  'thistle',
  'willow',
  'beacon',
  'cedar',
  'dune',
  'ember',
  'forest',
  'glade',
  'harbor',
  'island',
  'juniper',
  'kestrel',
  'lichen',
  'moss',
  'orchid',
  'pine',
  'rapids',
  'summit',
  'tulip',
];

// 3–32 chars, starts with letter, ends with letter/digit, [a-z0-9-] only.
export const SUBDOMAIN_RE = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;

export const RESERVED_SUBDOMAINS = new Set([
  'www',
  'api',
  'app',
  'admin',
  'auth',
  'login',
  'logout',
  'docs',
  'help',
  'status',
  'health',
  'ws',
  'static',
  'traefik',
  'dashboard',
  'mail',
  'smtp',
  'ftp',
]);

export function isReservedSubdomain(s: string): boolean {
  return RESERVED_SUBDOMAINS.has(s.toLowerCase());
}

const pick = <T>(arr: readonly T[]): T => {
  return arr[Math.floor(Math.random() * arr.length)];
};

export function generateSubdomain(): string {
  return `${pick(ADJECTIVES)}-${pick(NOUNS)}`;
}
