// gateway/auth/origins.js

let current = [];

export function getOrigins() {
  return current;
}

export function setOrigins(list) {
  current = [...new Set(Array.isArray(list) ? list : [])];
}
