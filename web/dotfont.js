// 5x7 dot-matrix numerals rendered as SVG (the big counters, like the hackathon site's).
const G = {
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
  "6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
  "$": ["00100", "01111", "10100", "01110", "00101", "11110", "00100"],
  ".": ["00000", "00000", "00000", "00000", "00000", "01100", "01100"],
  ",": ["00000", "00000", "00000", "00000", "01100", "00100", "01000"],
  ":": ["00000", "01100", "01100", "00000", "01100", "01100", "00000"],
  "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
};

/** Returns an <svg> string; dots use currentColor, so CSS colours it. Unknown chars render blank. */
export function dotSvg(text, { r = 3, gap = 9, ghost = true } = {}) {
  const chars = String(text).split("");
  const cell = gap; // spacing between dot centres
  const charW = 5 * cell + cell; // 5 columns + 1 spacer
  const w = chars.length * charW - cell;
  const h = 7 * cell - (cell - 2 * r);
  let dots = "";
  chars.forEach((ch, ci) => {
    const g = G[ch] || G[" "];
    g.forEach((row, y) => {
      [...row].forEach((v, x) => {
        const cx = ci * charW + x * cell + r;
        const cy = y * cell + r;
        if (v === "1") dots += `<circle cx="${cx}" cy="${cy}" r="${r}"/>`;
        else if (ghost) dots += `<circle cx="${cx}" cy="${cy}" r="${r}" opacity=".10"/>`;
      });
    });
  });
  return `<svg class="dots" viewBox="0 0 ${w + 2 * r - 2 * r + 0} ${h}" role="img" aria-label="${text}" fill="currentColor" preserveAspectRatio="xMinYMid meet">${dots}</svg>`;
}
