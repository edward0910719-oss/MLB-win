// Static branding data that MLB's public Stats API does not provide:
// Chinese team names, brand colors, and short division labels.
// Keyed by MLB Stats API numeric team id (stable, well-known IDs).
export const TEAM_META = {
  147: { zh: "洋基", div: "AL East", color: "#0C2340", accent: "#C4CED3" }, // NYY
  111: { zh: "紅襪", div: "AL East", color: "#BD3039", accent: "#0C2340" }, // BOS
  141: { zh: "藍鳥", div: "AL East", color: "#134A8E", accent: "#E8291C" }, // TOR
  139: { zh: "光芒", div: "AL East", color: "#092C5C", accent: "#8FBCE6" }, // TB
  110: { zh: "金鶯", div: "AL East", color: "#DF4601", accent: "#000000" }, // BAL

  114: { zh: "守護者", div: "AL Central", color: "#0C2340", accent: "#E31937" }, // CLE
  145: { zh: "白襪", div: "AL Central", color: "#27251F", accent: "#C4CED4" }, // CWS
  116: { zh: "老虎", div: "AL Central", color: "#0C2340", accent: "#FA4616" }, // DET
  118: { zh: "皇家", div: "AL Central", color: "#004687", accent: "#BD9B60" }, // KC
  142: { zh: "雙城", div: "AL Central", color: "#002B5C", accent: "#D31145" }, // MIN

  117: { zh: "太空人", div: "AL West", color: "#EB6E1F", accent: "#002D62" }, // HOU
  136: { zh: "水手", div: "AL West", color: "#0C2C56", accent: "#005C5C" }, // SEA
  140: { zh: "遊騎兵", div: "AL West", color: "#003278", accent: "#C0111F" }, // TEX
  108: { zh: "天使", div: "AL West", color: "#BA0021", accent: "#003263" }, // LAA
  133: { zh: "運動家", div: "AL West", color: "#003831", accent: "#EFB21E" }, // ATH

  144: { zh: "勇士", div: "NL East", color: "#CE1141", accent: "#13274F" }, // ATL
  121: { zh: "大都會", div: "NL East", color: "#002D72", accent: "#FF5910" }, // NYM
  143: { zh: "費城人", div: "NL East", color: "#E81828", accent: "#002D72" }, // PHI
  120: { zh: "國民", div: "NL East", color: "#AB0003", accent: "#14225A" }, // WSH
  146: { zh: "馬林魚", div: "NL East", color: "#00A3E0", accent: "#EF3340" }, // MIA

  158: { zh: "釀酒人", div: "NL Central", color: "#12284B", accent: "#B6922E" }, // MIL
  112: { zh: "小熊", div: "NL Central", color: "#0E3386", accent: "#CC3433" }, // CHC
  138: { zh: "紅雀", div: "NL Central", color: "#C41E3A", accent: "#0C2340" }, // STL
  113: { zh: "紅人", div: "NL Central", color: "#C6011F", accent: "#000000" }, // CIN
  134: { zh: "海盜", div: "NL Central", color: "#27251F", accent: "#FDB827" }, // PIT

  119: { zh: "道奇", div: "NL West", color: "#005A9C", accent: "#EF3E42" }, // LAD
  135: { zh: "教士", div: "NL West", color: "#2F241D", accent: "#FFC425" }, // SD
  137: { zh: "巨人", div: "NL West", color: "#FD5A1E", accent: "#27251F" }, // SF
  109: { zh: "響尾蛇", div: "NL West", color: "#A71930", accent: "#E3D4AD" }, // ARI
  115: { zh: "落磯", div: "NL West", color: "#333366", accent: "#C4CED4" }, // COL
};
