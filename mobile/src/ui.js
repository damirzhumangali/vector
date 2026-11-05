import React from 'react';
import Svg, { Circle, Path, Rect } from 'react-native-svg';

export const colors = {
  blue: '#087CFF',
  ink: '#142034',
  muted: '#8493AA',
  canvas: '#F5F7FC',
  tint: '#EAF4FF',
  border: '#E8EEF6',
  green: '#19B97E',
  orange: '#FF9C23',
  red: '#F45B6A',
};

const paths = {
  home: 'M3 10 12 3l9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z',
  clock: 'M12 7v5l3 2',
  chart: 'M4 21V13h4v8M10 21V4h4v17M16 21V9h4v12',
  user: 'M4 21v-2a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v2',
  users: 'M3 21v-2a5 5 0 0 1 5-5h4a5 5 0 0 1 5 5v2M17 5a4 4 0 0 1 0 8M20 15a5 5 0 0 1 2 4v2',
  calendar: 'M8 2v4m8-4v4M3 10h18M7 14h2m4 0h2m-8 4h2',
  clipboard: 'M8 4H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-3M8 12h8m-8 5h5',
  check: 'm5 12 4 4L19 6',
  'chevron-right': 'm9 5 7 7-7 7',
  'chevron-left': 'm15 5-7 7 7 7',
  plus: 'M12 5v14M5 12h14',
  search: 'm16 16 5 5',
  filter: 'M4 6h16M7 12h10m-7 6h4',
  pin: 'M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0Z',
  bell: 'M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4',
  settings: 'm9 3 1-2h4l1 2 3 2 2 .5 2 3-1 2v3l1 2-2 3-2 .5-3 2-1 2h-4l-1-2-3-2-2-.5-2-3 1-2v-3l-1-2 2-3L6 5Z',
  briefcase: 'M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M3 12a22 22 0 0 0 18 0M12 11v3',
  shield: 'M12 2 3 6v6c0 5 9 10 9 10s9-5 9-10V6Z',
  'arrow-right': 'M4 12h16m-6-6 6 6-6 6',
  upload: 'M12 16V3m-5 5 5-5 5 5M3 16v4a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-4',
  download: 'M12 3v13m-5-5 5 5 5-5M3 17v3a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-3',
  camera: 'M4 6h3l2-3h6l2 3h3a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1Z',
  refresh: 'M20 7a9 9 0 0 0-15-2L2 8m0-6v6h6m-4 9a9 9 0 0 0 15 2l3-3m0 6v-6h-6',
  wifi: 'M2 8.8a15 15 0 0 1 20 0M5 12.9a10 10 0 0 1 14 0M8.5 16.4a5 5 0 0 1 7 0M12 20h.01',
  'wifi-off': 'M2 2l20 20M2 8.8a15 15 0 0 1 3.3-2.2M8.7 5.4A15 15 0 0 1 22 8.8M5 12.9a10 10 0 0 1 4.7-2.6M15.4 10.6a10 10 0 0 1 3.6 2.3M8.5 16.4a5 5 0 0 1 7 0M12 20h.01',
  logout: 'M9 3H4v18h5M8 12h13m-5-5 5 5-5 5',
  link: 'm10 13 4-4m-7 5-2 2a4 4 0 0 0 6 6l5-5a4 4 0 0 0 0-6m1-1 2-2a4 4 0 0 0-6-6L8 7a4 4 0 0 0 0 6',
  building: 'M4 22V3h12v19M2 22h20M16 9h4v13M8 7h4m-4 4h4m-4 4h4m-4 4h4',
  alert: 'M12 3 2 21h20ZM12 9v5m0 3v.1',
  close: 'm6 6 12 12M6 18 18 6',
  play: 'm9 5 11 7-11 7Z',
  pause: 'M8 5v14m8-14v14',
  info: 'M12 11v6m0-10v.1',
  mail: 'm3 6 9 7 9-7',
};

export function Icon({ name, size = 22, color = colors.blue, strokeWidth = 1.8, style }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round"
      style={style} accessible={false}>
      {paths[name] && <Path d={paths[name]} />}
      {['clock', 'info'].includes(name) && <Circle cx="12" cy="12" r="9" />}
      {['user', 'users'].includes(name) && <Circle cx={name === 'users' ? '10' : '12'} cy="6" r="4" />}
      {name === 'calendar' && <Rect x="3" y="4" width="18" height="18" rx="2" />}
      {name === 'clipboard' && <Rect x="8" y="2" width="8" height="5" rx="1" />}
      {name === 'search' && <Circle cx="10" cy="10" r="7" />}
      {name === 'pin' && <Circle cx="12" cy="10" r="2.5" />}
      {name === 'settings' && <Circle cx="12" cy="12" r="3" />}
      {name === 'briefcase' && <Rect x="3" y="6" width="18" height="15" rx="2" />}
      {name === 'camera' && <Circle cx="12" cy="13" r="4" />}
      {name === 'mail' && <Rect x="3" y="4" width="18" height="16" rx="2" />}
    </Svg>
  );
}
