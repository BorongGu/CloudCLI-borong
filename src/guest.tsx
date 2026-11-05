import React from 'react';
import { createRoot } from 'react-dom/client';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { createInstance } from 'i18next';

import { GuestChat } from '@/modules/guest-chat';
import 'katex/dist/katex.min.css';

const i18n = createInstance();
void i18n.use(initReactI18next).init({ lng: 'zh-CN', fallbackLng: 'zh-CN', defaultNS: 'chat', initImmediate: false,
  resources: { 'zh-CN': { chat: { codeBlock: { copied: '已复制', copyCode: '复制代码' } } } }, interpolation: { escapeValue: false },
});
createRoot(document.getElementById('root')!).render(<React.StrictMode><I18nextProvider i18n={i18n}><GuestChat /></I18nextProvider></React.StrictMode>);
