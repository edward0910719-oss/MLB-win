// Static branding + ballpark data that MLB's public Stats API does not provide cleanly:
// Chinese team names, brand colors, short division labels, home-park run factor,
// venue coordinates (for weather lookups), and whether the home park is a dome/roof
// that's normally closed (weather effects skipped for those).
//
// parkFactor is an approximate multi-year runs park factor (100 = neutral,
// >100 hitter-friendly, <100 pitcher-friendly) based on commonly published
// sabermetric figures. These drift year to year — treat as a directional
// signal, not a precise/official Statcast number.
//
// Keyed by MLB Stats API numeric team id (stable, well-known IDs).
export const TEAM_META = {
  147: { zh: "洋基", div: "AL East", color: "#0C2340", accent: "#C4CED3", parkFactor: 103, venue: { lat: 40.8296, lon: -73.9262 }, isDome: false }, // NYY - Yankee Stadium
  111: { zh: "紅襪", div: "AL East", color: "#BD3039", accent: "#0C2340", parkFactor: 103, venue: { lat: 42.3467, lon: -71.0972 }, isDome: false }, // BOS - Fenway Park
  141: { zh: "藍鳥", div: "AL East", color: "#134A8E", accent: "#E8291C", parkFactor: 101, venue: { lat: 43.6414, lon: -79.3894 }, isDome: true }, // TOR - Rogers Centre (retractable, usually closed)
  139: { zh: "光芒", div: "AL East", color: "#092C5C", accent: "#8FBCE6", parkFactor: 96, venue: { lat: 27.7683, lon: -82.6534 }, isDome: true }, // TB - Tropicana Field (fixed dome)
  110: { zh: "金鶯", div: "AL East", color: "#DF4601", accent: "#000000", parkFactor: 97, venue: { lat: 39.2838, lon: -76.6217 }, isDome: false }, // BAL - Camden Yards

  114: { zh: "守護者", div: "AL Central", color: "#0C2340", accent: "#E31937", parkFactor: 98, venue: { lat: 41.4962, lon: -81.6852 }, isDome: false }, // CLE - Progressive Field
  145: { zh: "白襪", div: "AL Central", color: "#27251F", accent: "#C4CED4", parkFactor: 101, venue: { lat: 41.8299, lon: -87.6338 }, isDome: false }, // CWS - Rate Field
  116: { zh: "老虎", div: "AL Central", color: "#0C2340", accent: "#FA4616", parkFactor: 97, venue: { lat: 42.3390, lon: -83.0485 }, isDome: false }, // DET - Comerica Park
  118: { zh: "皇家", div: "AL Central", color: "#004687", accent: "#BD9B60", parkFactor: 98, venue: { lat: 39.0517, lon: -94.4803 }, isDome: false }, // KC - Kauffman Stadium
  142: { zh: "雙城", div: "AL Central", color: "#002B5C", accent: "#D31145", parkFactor: 99, venue: { lat: 44.9817, lon: -93.2776 }, isDome: false }, // MIN - Target Field

  117: { zh: "太空人", div: "AL West", color: "#EB6E1F", accent: "#002D62", parkFactor: 101, venue: { lat: 29.7573, lon: -95.3555 }, isDome: true }, // HOU - Minute Maid Park (retractable, usually closed)
  136: { zh: "水手", div: "AL West", color: "#0C2C56", accent: "#005C5C", parkFactor: 95, venue: { lat: 47.5914, lon: -122.3325 }, isDome: false }, // SEA - T-Mobile Park (retractable, often open)
  140: { zh: "遊騎兵", div: "AL West", color: "#003278", accent: "#C0111F", parkFactor: 100, venue: { lat: 32.7473, lon: -97.0842 }, isDome: true }, // TEX - Globe Life Field (retractable, usually closed)
  108: { zh: "天使", div: "AL West", color: "#BA0021", accent: "#003263", parkFactor: 99, venue: { lat: 33.8003, lon: -117.8827 }, isDome: false }, // LAA - Angel Stadium
  133: { zh: "運動家", div: "AL West", color: "#003831", accent: "#EFB21E", parkFactor: 108, venue: { lat: 38.5802, lon: -121.5137 }, isDome: false }, // ATH - Sutter Health Park (small minor-league park, plays small)

  144: { zh: "勇士", div: "NL East", color: "#CE1141", accent: "#13274F", parkFactor: 101, venue: { lat: 33.8908, lon: -84.4678 }, isDome: false }, // ATL - Truist Park
  121: { zh: "大都會", div: "NL East", color: "#002D72", accent: "#FF5910", parkFactor: 96, venue: { lat: 40.7571, lon: -73.8458 }, isDome: false }, // NYM - Citi Field
  143: { zh: "費城人", div: "NL East", color: "#E81828", accent: "#002D72", parkFactor: 104, venue: { lat: 39.9061, lon: -75.1665 }, isDome: false }, // PHI - Citizens Bank Park
  120: { zh: "國民", div: "NL East", color: "#AB0003", accent: "#14225A", parkFactor: 99, venue: { lat: 38.8730, lon: -77.0074 }, isDome: false }, // WSH - Nationals Park
  146: { zh: "馬林魚", div: "NL East", color: "#00A3E0", accent: "#EF3340", parkFactor: 94, venue: { lat: 25.7781, lon: -80.2197 }, isDome: true }, // MIA - loanDepot Park (retractable, usually closed)

  158: { zh: "釀酒人", div: "NL Central", color: "#12284B", accent: "#B6922E", parkFactor: 100, venue: { lat: 43.0280, lon: -87.9712 }, isDome: true }, // MIL - American Family Field (retractable, often closed)
  112: { zh: "小熊", div: "NL Central", color: "#0E3386", accent: "#CC3433", parkFactor: 102, venue: { lat: 41.9484, lon: -87.6553 }, isDome: false }, // CHC - Wrigley Field
  138: { zh: "紅雀", div: "NL Central", color: "#C41E3A", accent: "#0C2340", parkFactor: 97, venue: { lat: 38.6226, lon: -90.1928 }, isDome: false }, // STL - Busch Stadium
  113: { zh: "紅人", div: "NL Central", color: "#C6011F", accent: "#000000", parkFactor: 105, venue: { lat: 39.0979, lon: -84.5066 }, isDome: false }, // CIN - Great American Ball Park
  134: { zh: "海盜", div: "NL Central", color: "#27251F", accent: "#FDB827", parkFactor: 96, venue: { lat: 40.4469, lon: -80.0057 }, isDome: false }, // PIT - PNC Park

  119: { zh: "道奇", div: "NL West", color: "#005A9C", accent: "#EF3E42", parkFactor: 97, venue: { lat: 34.0739, lon: -118.2400 }, isDome: false }, // LAD - Dodger Stadium
  135: { zh: "教士", div: "NL West", color: "#2F241D", accent: "#FFC425", parkFactor: 95, venue: { lat: 32.7073, lon: -117.1566 }, isDome: false }, // SD - Petco Park
  137: { zh: "巨人", div: "NL West", color: "#FD5A1E", accent: "#27251F", parkFactor: 90, venue: { lat: 37.7786, lon: -122.3893 }, isDome: false }, // SF - Oracle Park
  109: { zh: "響尾蛇", div: "NL West", color: "#A71930", accent: "#E3D4AD", parkFactor: 100, venue: { lat: 33.4455, lon: -112.0667 }, isDome: true }, // ARI - Chase Field (retractable, usually closed)
  115: { zh: "落磯", div: "NL West", color: "#333366", accent: "#C4CED4", parkFactor: 112, venue: { lat: 39.7559, lon: -104.9942 }, isDome: false }, // COL - Coors Field
};
