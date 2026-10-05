# FrogShare
screen-share-app para skzpetentes

## Build

- Windows: `npm run dist` (usa `native/AudioCapture.exe`)
- macOS (Apple Silicon): `npm run dist:mac` → `dist/FrogShare-<versão>-arm64.dmg`
  - O som vem de `native/AudioCapture-mac` (Core Audio process taps, macOS 14.2+). Depois de mexer em `native/mac/AudioCapture.swift`, rode `npm run build:native:mac` e commite o binário.
  - Sem conta Apple Developer o app é assinado ad-hoc (`build/adhoc-sign.js`); quem baixa precisa liberar em Ajustes do Sistema › Privacidade e Segurança › Abrir Mesmo Assim.
  - Para aparecer o botão "Baixar para Mac" no site, preencha `macUrl` em `server/index.js`.
