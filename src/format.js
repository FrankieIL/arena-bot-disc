const MEDALS = ['🥇', '🥈', '🥉'];

/**
 * Medal for the top 3, otherwise "N." for the rest — the period is
 * backslash-escaped so Discord doesn't silently parse a row starting with
 * "4. Name" as Markdown ordered-list syntax (see README's Discord quirks
 * section), which would give that row different line spacing than the rest.
 * Shared between leaderboard.js and seasonHighs.js.
 */
function formatServerPosition(index) {
  return MEDALS[index] ?? `${index + 1}\\.`;
}

module.exports = { formatServerPosition };
