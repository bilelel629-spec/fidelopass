export type DashboardNavItem = {
  href: string;
  id: string;
  label: string;
  paths: string[];
};

export const DASHBOARD_NAV_ITEMS: DashboardNavItem[] = [
  { href: '/dashboard', id: 'dashboard', label: 'Dashboard', paths: ['M4 13h6V4H4zm10 7h6v-9h-6zm0-11h6V4h-6zM4 20h6v-5H4z'] },
  { href: '/dashboard/carte', id: 'carte', label: 'Ma carte', paths: ['M3 8a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3zm0 3h18'] },
  { href: '/dashboard/notifications', id: 'notifications', label: 'Notifications push', paths: ['M15 17h5l-1.4-1.4A2 2 0 0 1 18 14.2V11A6 6 0 0 0 6 11v3.2a2 2 0 0 1-.6 1.4L4 17h5', 'M9 17a3 3 0 0 0 6 0'] },
  { href: '/dashboard/points-vente', id: 'points-vente', label: 'Points de vente', paths: ['M3 11.5L12 4l9 7.5', 'M5 10.5V20h14v-9.5', 'M9 20v-4h6v4'] },
  { href: '/dashboard/clients', id: 'clients', label: 'Clients', paths: ['M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2', 'M13 7a4 4 0 1 1-8 0a4 4 0 1 1 8 0', 'M22 21v-2a4 4 0 0 0-3-3.87', 'M16 3.13a4 4 0 0 1 0 7.75'] },
  { href: '/dashboard/transactions', id: 'transactions', label: 'Historique', paths: ['M3 17l6-6 4 4 8-8', 'M21 7h-6v6'] },
  { href: '/dashboard/parametres', id: 'parametres', label: 'Mon compte commerçant', paths: ['M12 3v2.2', 'M12 18.8V21', 'M4.93 4.93l1.56 1.56', 'M17.51 17.51l1.56 1.56', 'M3 12h2.2', 'M18.8 12H21', 'M4.93 19.07l1.56-1.56', 'M17.51 6.49l1.56-1.56', 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8'] },
];
