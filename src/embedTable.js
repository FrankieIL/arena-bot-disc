// Discord embed field values are capped at 1024 characters — a single
// "Rank" column combining a custom emoji mention, tier, division/LP, and a
// region-rank number can approach that on a server with enough registered
// players (confirmed live: 17 rows landed at 1020/1024). Splitting the
// roster into multiple aligned field-groups fixes this without dropping any
// column or truncating any row — Discord's inline-field grid just continues
// as another set of 3 columns beneath the first, the same way a long table
// continues onto a second page rather than losing rows.
const MAX_FIELD_VALUE_LENGTH = 1000;

/**
 * Splits three parallel arrays of already-formatted row strings (one per
 * embed column, all the same length, row-for-row aligned) into groups that
 * each stay under `maxLength` once joined with newlines. A split only
 * happens between rows — never mid-row — and is triggered as soon as *any*
 * one of the three columns in the current group would cross the limit, so
 * every group's three columns stay aligned to the exact same row range
 * (required for Discord's 3-column inline-field grid to actually line up).
 * Returns an array of `[colA, colB, colC]` triples, each a slice of the
 * original arrays.
 */
function chunkRows(columnA, columnB, columnC, maxLength = MAX_FIELD_VALUE_LENGTH) {
  const chunks = [];
  let chunkA = [];
  let chunkB = [];
  let chunkC = [];
  let lenA = 0;
  let lenB = 0;
  let lenC = 0;

  for (let i = 0; i < columnA.length; i += 1) {
    const addedA = columnA[i].length + (chunkA.length > 0 ? 1 : 0);
    const addedB = columnB[i].length + (chunkB.length > 0 ? 1 : 0);
    const addedC = columnC[i].length + (chunkC.length > 0 ? 1 : 0);

    const wouldOverflow = chunkA.length > 0
      && (lenA + addedA > maxLength || lenB + addedB > maxLength || lenC + addedC > maxLength);

    if (wouldOverflow) {
      chunks.push([chunkA, chunkB, chunkC]);
      chunkA = [];
      chunkB = [];
      chunkC = [];
      lenA = 0;
      lenB = 0;
      lenC = 0;
    }

    chunkA.push(columnA[i]);
    chunkB.push(columnB[i]);
    chunkC.push(columnC[i]);
    lenA += columnA[i].length + (chunkA.length > 1 ? 1 : 0);
    lenB += columnB[i].length + (chunkB.length > 1 ? 1 : 0);
    lenC += columnC[i].length + (chunkC.length > 1 ? 1 : 0);
  }

  if (chunkA.length > 0) {
    chunks.push([chunkA, chunkB, chunkC]);
  }

  return chunks;
}

/**
 * Adds a 3-column table (Players/Rank/Rating-style) to an embed, splitting
 * it across as many aligned field-groups as needed to keep every field
 * under Discord's 1024-char limit. Only the first group gets real column
 * headers — later groups use a zero-width-space name so they read as a
 * visual continuation of the same table rather than a repeated header.
 */
function addTableFields(embed, headers, columnA, columnB, columnC) {
  const chunks = chunkRows(columnA, columnB, columnC);

  chunks.forEach(([rowsA, rowsB, rowsC], i) => {
    embed.addFields(
      { name: i === 0 ? headers[0] : '​', value: rowsA.join('\n'), inline: true },
      { name: i === 0 ? headers[1] : '​', value: rowsB.join('\n'), inline: true },
      { name: i === 0 ? headers[2] : '​', value: rowsC.join('\n'), inline: true },
    );
  });
}

module.exports = { chunkRows, addTableFields };
