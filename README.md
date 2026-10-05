# FrogShare 🐸

Uma alternativa ao "Go Live" do Discord: transmita um jogo, uma janela ou a tela inteira **com o som de um app específico** (só o jogo, sem o Discord e sem as notificações) para os seus amigos, que assistem direto no navegador, sem instalar nada.

- **Site:** [frogshare.onrender.com](https://frogshare.onrender.com), de onde se baixa o app e onde os amigos assistem.
- **Host:** app para Windows (e macOS com Apple Silicon) que captura e transmite.
- **Espectadores:** abrem o link da sala em qualquer navegador.

## O que ele faz

- **Som por app:** no Windows, captura só o áudio do processo escolhido (WASAPI process loopback). No macOS 14.2+, usa Core Audio process taps. Também dá para mandar o som do PC inteiro ou nenhum som.
- **Codificação na placa de vídeo:** H.264 por NVENC, AMF ou QuickSync, com um pipeline próprio que mantém os quadros na GPU e um *pacer* que evita perda de quadros quando o jogo ocupa a placa.
- **Qualidade ajustável ao vivo:** 720p, 1080p ou nativa, em 30 ou 60 fps.
- **Funciona atrás de qualquer rede:** conexão direta (P2P) quando possível, com relay TURN da Cloudflare para NAT restritivo e CGNAT de operadora móvel.
- **Muitos espectadores:** a partir de 3 pessoas, o host envia uma única cópia para o SFU da Cloudflare, que distribui para todos.
- **Leve durante o jogo:** com o app minimizado ou atrás do jogo, nada na interface é redesenhado.
- **Aviso "ao vivo":** ao minimizar, aparece um aviso pequeno que fica fora da própria transmissão.
- **Atualização pelo próprio app**, com verificação SHA-512 do instalador.

## Como funciona

```
 App do host (Electron)                     Servidor (Node, Render)               Espectadores (navegador)
 ┌──────────────────────────┐   salas e    ┌─────────────────────────┐   site   ┌──────────────────────┐
 │ captura de tela (DXGI)   │  sinalização │ Express + Socket.IO     │ ───────▶ │ room.html            │
 │ captura de som (nativo)  │ ◀──────────▶ │ credenciais TURN/SFU    │ ◀──────▶ │ WebRTC (recebe)      │
 │ pipeline GPU + encoder   │              │ limite mensal de relay  │          └──────────────────────┘
 │ WebRTC (envia)           │ ═══════════════ vídeo e som: P2P, TURN ou SFU (Cloudflare) ═══════════════▶
 └──────────────────────────┘
```

O servidor só apresenta as pessoas umas às outras e entrega credenciais temporárias. **Vídeo e som nunca passam por ele.**

## Estrutura

| Pasta | O que tem |
|---|---|
| `src/` | Processo principal do Electron (`main.js`): janelas, captura, aviso ao vivo, prioridades e atualização. `preload.js` expõe uma API mínima para a interface. `server.js` serve as telas do app só em `127.0.0.1`. |
| `public/` | Interface do app: `host.html` com `js/host.js` (lógica de transmissão) e `js/host-ui.js` (só apresentação), além do aviso ao vivo (`overlay.*`). |
| `native/` | Capturadores de som: `AudioCapture.cs` (Windows, WASAPI) e `mac/AudioCapture.swift` (macOS), com os binários compilados. |
| `server/` | Servidor de sinalização (`index.js`) e o site em `server/public/`: página inicial, sala e a pasta `brand/` com tema, ícones e mascote, compartilhada com o app. |
| `build/` | Assinatura ad-hoc do build de macOS. |

## Desenvolvimento

Requisitos: Node 20+ e Windows 10 (versão 2004) ou mais novo para o som por app. No macOS 14.2+, veja a seção de build.

```bash
npm install
npm start                      # abre o app (usa o servidor público por padrão)
```

Para rodar com um servidor local:

```bash
cd server && npm install && PORT=3041 node index.js
SIGNAL_SERVER=http://127.0.0.1:3041 npm start
```

Sem as variáveis de ambiente abaixo, o servidor local funciona só com conexão direta: sem TURN, sem SFU e sem logs.

### Variáveis do servidor

Configure no painel do Render. **Nunca** coloque valores no código nem em commits; `.env` e `.env.local` já estão no `.gitignore`.

| Variável | Para quê |
|---|---|
| `CF_TURN_KEY_ID`, `CF_TURN_API_TOKEN` | Gera credenciais TURN temporárias (Cloudflare Realtime) |
| `CF_SFU_APP_ID`, `CF_SFU_APP_SECRET` | SFU para salas com 3+ espectadores. O segredo nunca sai do servidor. |
| `CF_ACCOUNT_ID`, `CF_ANALYTICS_TOKEN`, `CF_GRAPHQL_URL` | Lê o consumo oficial da Cloudflare para respeitar o limite mensal gratuito |
| `TURN_MONTHLY_CAP_GB` | Limite mensal de relay e SFU (padrão: 900 GB) |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Logs de erro e de qualidade, total de uso e bloqueios de sala |
| `ADMIN_KEY` | Chave da rota de moderação `/api/admin/close-room`. Sem ela, a rota fica desligada. |

## Build

- **Windows:** `npm run dist` gera o instalador NSIS (`dist/FrogShare Setup <versão>.exe`) e a versão portátil.
- **macOS (Apple Silicon):** `npm run dist:mac` gera `dist/FrogShare-<versão>-arm64.dmg`.
  - O som vem de `native/AudioCapture-mac` (Core Audio process taps, macOS 14.2+). Depois de mexer em `native/mac/AudioCapture.swift`, rode `npm run build:native:mac` e commite o binário.
  - Sem conta Apple Developer, o app é assinado ad-hoc (`build/adhoc-sign.js`). Quem baixa precisa liberar em Ajustes do Sistema › Privacidade e Segurança › Abrir Mesmo Assim.
  - Para aparecer o botão "Baixar para Mac" no site, preencha `macUrl` em `server/index.js`.

### Publicar uma versão

1. Suba a versão em `package.json` e nas strings `app_version` (`src/main.js`, `public/js/host.js`, `server/public/js/room.js`) e gere o build.
2. Crie a release `vX.Y.Z` no GitHub com o instalador `FrogShare Setup X.Y.Z.exe` (o GitHub o renomeia para `FrogShare.Setup.X.Y.Z.exe`) e uma cópia chamada `FrogShare-Setup.exe`. O botão do site aponta para `releases/latest/download/FrogShare-Setup.exe`, então ele passa a entregar a versão nova sozinho.
3. Atualize `LATEST_APP` em `server/index.js` com `version`, o `url` do instalador dessa release, `size` e `sha512` (SHA-512 em base64). O atualizador do app recusa qualquer arquivo que não bata com esse hash.

## Segurança

- **Salas:** quem cria a sala recebe uma chave de host. Só ela permite transmitir na sala, então ninguém que tenha o link consegue tomar a transmissão. As mensagens de sinalização só circulam entre membros da mesma sala.
- **Servidor:** limites por IP nas rotas que gravam ou alocam recursos, cabeçalhos de segurança (CSP, nosniff, anti-iframe), códigos de sala validados e registros internos (uso, bloqueios) que não podem ser forjados pela rota pública de logs.
- **App:** `contextIsolation` ligado, sem Node na interface, navegação e janelas novas bloqueadas, permissões restritas a captura de tela e área de transferência, e biblioteca externa carregada com Subresource Integrity.
- **Atualização:** o instalador só roda se o tamanho e o SHA-512 baterem com o que o servidor publica.

Encontrou uma vulnerabilidade? Veja [SECURITY.md](SECURITY.md).

## Créditos

Feito por [Igor Figueiredo](https://github.com/IgorFigueiredo28), com o build de macOS por [Vinícius Ventura](https://github.com/viniciusventura29).
