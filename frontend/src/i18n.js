import { createContext, useContext } from 'react';

const translations = {
  'nav.chat': 'Chat',
  'nav.docs': 'Documents',
  'nav.translate': 'Translate',
  'nav.profile': 'Profile',
  'nav.settings': 'Settings',
  'sidebar.chats': 'Chats',
  'sidebar.noChats': 'No conversations yet',
  'sidebar.newChat': 'New Chat',
  'sidebar.searchChats': 'Search chats...',
};

const I18nContext = createContext({ t: (key) => translations[key] || key });

export function useTranslation() {
  return useContext(I18nContext);
}