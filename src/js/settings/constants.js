// Navigation structure & static option lists for Settings

export const NAV = [
  ['Island', [
    ['notch', 'Notch', 'ti-device-desktop', '#0a84ff'],
    ['menu', 'Menu', 'ti-layout-grid', '#8e5cf5'],
    ['music', 'Music', 'ti-music', '#ff375f'],
    ['widgets', 'Widgets', 'ti-cloud', '#32ade6'],
    ['animations', 'Animations', 'ti-sparkles', '#bf5af2']
  ]],
  ['Activities', [
    ['notifications', 'Notifications', 'ti-bell', '#5e5ce6'],
    ['sounds', 'Sound & Time', 'ti-volume', '#ff453a'],
    ['connect', 'Connect', 'ti-bluetooth', '#30b0c7'],
    ['screentime', 'Screen time', 'ti-hourglass', '#ff9f0a']
  ]],
  ['App', [
    ['system', 'System', 'ti-settings', '#8e8e93'],
    ['about', 'About', 'ti-info-circle', '#64748b']
  ]]
];

// every font the island supports (keys match FONT_MAP in shared.js)
export const FONT_OPTS = [
  ['matrix', 'Doto (Dot Matrix Display)'],
  ['spacemono', 'Space Mono (Technical Mono)'],
  ['mono', 'JetBrains Mono (Developer Code)'],
  ['inter', 'Inter (Crisp & Minimal)'],
  ['poppins', 'Poppins (Geometric & Vibrant)'],
  ['outfit', 'Outfit (Friendly & Rounded)'],
  ['space', 'Space Grotesk (Tech & Brutalist)'],
  ['montserrat', 'Montserrat (Classic & Elegant)'],
  ['lexend', 'Lexend (Ultra-Readable)'],
  ['syne', 'Syne (Futuristic & Expressive)'],
  ['raleway', 'Raleway (Stylish & Sleek)'],
  ['jakarta', 'Plus Jakarta Sans'],
  ['system', 'Windows Segoe UI (Native)']
];

export const WIDGET_OPTS = [
  ['weather', 'Weather'], ['cpu', 'CPU %'], ['ram', 'RAM %'], ['gpu', 'GPU %'],
  ['disk', 'Disk %'], ['battery', 'Battery %'], ['net', 'Net speed']
];

// symbol, label (same presets the Markets widget uses)
export const MARKET_PRESETS = [
  ['BTC-USD', 'Bitcoin (BTC)'], ['ETH-USD', 'Ethereum (ETH)'], ['SOL-USD', 'Solana (SOL)'],
  ['^NSEI', 'NIFTY 50'], ['^BSESN', 'SENSEX'], ['^GSPC', 'S&P 500'], ['^IXIC', 'NASDAQ'], ['^DJI', 'DOW'],
  ['TSLA', 'Tesla (TSLA)'], ['AAPL', 'Apple (AAPL)'], ['NVDA', 'NVIDIA (NVDA)'], ['MSFT', 'Microsoft (MSFT)'],
  ['GOOGL', 'Alphabet (GOOGL)'], ['AMZN', 'Amazon (AMZN)'], ['GC=F', 'Gold']
];

export const SKINS = [
  ['eyes', 'Cyber Eyes (Original)', '◉ ◉', '#2db8a6'],
  ['orbs', 'Round Eyes', '● ●', '#ffffff'],
  ['slits', 'Slit Eyes', '▮ ▮', '#ffb02e'],
  ['visor', 'Visor', '▬▬', '#c040e0'],
  ['cat', '8-Bit Cat', '🐱', '#ff9f0a'],
  ['dots', 'Dots', '• • •', '#ffffff']
];

export const TRAY_ANIM_OPTS = [
  { id: 'bounce', label: 'Soft Bounce', desc: 'Falling document bounces gently into the tray pill' }
];

export const RECEIVE_ANIM_OPTS = [
  { id: 'radar', label: 'Radar Card', desc: 'Outer radar rings, expanded Accept/Decline card & continuous file drops' },
  { id: 'notch', label: 'Notch Prompt', desc: 'Classic compact notch prompt with falling file drops after Accept' }
];

export const SEND_ANIM_OPTS = [
  { id: 'beam', label: 'Launch Beam', desc: 'Status HUD gradient progress beam with completion burst' },
  { id: 'trace', label: 'Edge Trace', desc: 'Perimeter light synced with Floating pill or Bezel status edge' }
];

export const MEDIA_CARD_OPTS = [
  { id: 'classic', label: 'Classic', desc: 'Island surface synced with your notch colour and ambient glow' },
  { id: 'glass', label: 'Glass Card', desc: 'Independent frosted blur card with glowing backdrop & wave seek' }
];

export const EQ_STYLE_OPTS = [
  { id: 'bottom', label: 'Bottom Rise', desc: 'Wave bars rise upward cleanly from the baseline' },
  { id: 'center', label: 'Center Pulse', desc: 'Symmetrical waveform pulsing up and down from center' }
];
