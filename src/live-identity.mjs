// Evidence must come from the resolved page, not echoed input query parameters.
export function matchesResolvedPlace(record, href) {
  let url; try { url = new URL(href); } catch { return false; }
  if (url.protocol !== 'https:' || !/^(?:www\.|maps\.)?google\.(?:com|[a-z]{2}|(?:com|co)\.[a-z]{2})$/i.test(url.hostname)) return false;
  for (const key of ['query_place_id', 'place_id', 'cid', 'ludocid', 'ftid', 'query']) url.searchParams.delete(key);
  let material; try { material = decodeURIComponent(url.pathname + url.search + url.hash); } catch { return false; }
  const value = record.identity.slice(record.identity.indexOf(':') + 1);
  const tokens = [...material.matchAll(/!1s([^!/?&#]+)/g)].map(m => m[1]);
  if (['place_id', 'maps_data_id', 'ftid'].includes(record.identityKind)) return tokens.includes(value);
  if (record.identityKind === 'cid') {
    try { return tokens.some(t => /^0x[0-9a-f]+:0x[0-9a-f]+$/i.test(t) && BigInt(t.split(':')[1]) === BigInt(value)); } catch { return false; }
  }
  // A viewport's center does not identify a saved coordinate pin reliably.
  return false;
}
