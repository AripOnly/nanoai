// src/skills/search.js
//
// Deterministic lexical search over the catalog metadata. There is no model
// call and no embedding index: skills are few, and the prompt is supposed to
// stay bounded even when the catalog is truncated.

const MAX_RESULTS = 10;

export function normalizeSearchText(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenize(value) {
  return normalizeSearchText(value)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .slice(0, 32);
}

function textIncludes(haystack, needle) {
  return normalizeSearchText(haystack).includes(needle);
}

function tokenHits(values, tokens) {
  let score = 0;
  for (const value of values) {
    const normalized = normalizeSearchText(value);
    if (!normalized) continue;
    for (const token of tokens) {
      if (normalized === token) score += 8;
      else if (normalized.includes(token)) score += 3;
    }
  }
  return score;
}

export function scoreSkill(skill, query) {
  const normalizedQuery = normalizeSearchText(query);
  if (normalizedQuery === "") return 0;
  const tokens = tokenize(normalizedQuery);
  const name = normalizeSearchText(skill.name);
  let score = 0;

  if (name === normalizedQuery) score += 120;
  else if (name.startsWith(normalizedQuery)) score += 70;
  else if (name.includes(normalizedQuery)) score += 45;
  score += tokenHits([skill.name], tokens) * 2;

  score += tokenHits(skill.tags ?? [], tokens) * 4;
  score += tokenHits(skill.triggers ?? [], tokens) * 5;
  score += tokenHits([skill.description], tokens) * 2;

  const fullPhraseFields = [
    ...(skill.tags ?? []),
    ...(skill.triggers ?? []),
    skill.description,
  ];
  for (const field of fullPhraseFields) {
    if (textIncludes(field, normalizedQuery)) score += 6;
  }

  return score;
}

/**
 * Search allowed/compatible entries. Results are copies with a `score` field;
 * the caller decides which metadata to show the model.
 */
export function searchSkills(entries, query, limit = MAX_RESULTS) {
  const normalized = normalizeSearchText(query);
  const count = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), MAX_RESULTS) : MAX_RESULTS;
  const scored = [];

  for (const entry of entries ?? []) {
    const score = scoreSkill(entry, normalized);
    if (normalized !== "" && score <= 0) continue;
    scored.push({
      ...entry,
      score,
    });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return String(a.name).localeCompare(String(b.name));
  });

  return scored.slice(0, count);
}

export const MAX_SEARCH_RESULTS = MAX_RESULTS;
