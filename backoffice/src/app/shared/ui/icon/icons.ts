/**
 * Registry of the application's own inline SVG icons: path data on a 24x24 grid, drawn with a
 * 2px round stroke (`currentColor`). No icon package is used.
 */
export const ICONS = {
  menu: 'M4 6h16M4 12h16M4 18h16',
  close: 'M6 6l12 12M18 6L6 18',
  'chevron-left': 'M15 6l-6 6 6 6',
  'chevron-right': 'M9 6l6 6-6 6',
  'chevron-up': 'M6 15l6-6 6 6',
  building: 'M5 21V4h9v17M14 9h5v12M3 21h18M8 8h2M8 12h2M8 16h2',
  store: 'M4 9l1.5-5h13L20 9M4 9v11h16V9M4 9h16M9 20v-6h6v6',
  more: 'M12 6v.01M12 12v.01M12 18v.01',
  'chevron-down': 'M6 9l6 6 6-6',
  sort: 'M8 9l4-4 4 4M8 15l4 4 4-4',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  alert: 'M12 4L2.5 20h19L12 4zM12 10v4M12 17.5v.01',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5M12 7.5v.01',
  error: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9 9l6 6M15 9l-6 6',
  sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  moon: 'M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z',
  plus: 'M12 5v14M5 12h14',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4',
  logout: 'M10 4H5v16h5M15 8l4 4-4 4M19 12H9',
  home: 'M4 11l8-7 8 7M6 10v10h12V10',
  users:
    'M9 12a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 19c0-3 2.9-5 6.5-5s6.5 2 6.5 5M16 5.2a3.5 3.5 0 0 1 0 6.6M18 14.3c2 .6 3.5 2.2 3.5 4.7',
  log: 'M6 3h12v18H6zM9 8h6M9 12h6M9 16h4',
  settings: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 4v6M9 14v6',
  card: 'M3 6h18v12H3zM3 10h18M7 15h4',
  star: 'M12 4l2.4 5 5.6.7-4.1 3.8 1.1 5.5L12 16.2 7 19l1.1-5.5L4 9.7 9.6 9z',
  gift: 'M4 10h16v10H4zM3 7h18v3H3zM12 7v13M12 7c-2.5 0-4-1-4-2.5S9.5 2 12 7zM12 7c2.5 0 4-1 4-2.5S14.5 2 12 7z',
  tag: 'M3 12V4h8l10 10-8 8zM7.5 8v.01',
  release: 'M12 4v10M8 10l4 4 4-4M5 19h14',
  external: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
  mail: 'M3 6h18v12H3zM3 7l9 6 9-6',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5M14 11v5',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 20c0-3.3 3.6-6 8-6s8 2.7 8 6',
} as const;

/** Name of an available icon. */
export type IconName = keyof typeof ICONS;
