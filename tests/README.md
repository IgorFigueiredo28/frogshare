# Testes automáticos

Rodam contra um servidor local e não capturam a tela de verdade: os streams são de canvas e todas as
janelas de teste ficam escondidas e mudas (nada toca no alto-falante, nada rouba o foco).

1. Suba o servidor numa porta livre:

   ```
   node -e "process.env.PORT='3041'; require('./server/index.js')"
   ```

2. Rode os testes (o endereço é opcional; o padrão é `http://127.0.0.1:3041`):

   | Comando | O que testa |
   |---|---|
   | `node tests/server-events.js http://127.0.0.1:3041` | Eventos do servidor: nomes, reações, economia de dados, saúde da transmissão, tirar e trancar, salas com nome, prévia do link |
   | `npx electron tests/e2e-viewer.js` | Página de quem assiste: link curto, nomes, reações, economia de dados, volume equilibrado, print, clipe, zoom, modo cinema, atalhos, "por que trava", tirado/trancada, salas recentes, mixer do grupo |
   | `npx electron tests/e2e-webhost.js` | Transmitir pelo navegador (transmitir.html), sozinho e entrando no grupo de um amigo |
   | `npx electron tests/e2e-app.js` | O app (escondido, perfil próprio): link fixo e com nome, câmera falsa no canto, lista de quem assiste, reações, economia de dados, pausa rápida, janela que não dá para capturar nunca vira a tela inteira, jogo minimizado com "já volta" até voltar, nome do jogo, atalho global, trancar e tirar |

O teste do app usa a câmera falsa do Chromium e entrega ao app um canvas no lugar da captura (a captura
rápida do Windows não pega janelas fora dos monitores); todo o resto é o código de verdade.

`/api/room/create` aceita 20 salas por minuto por IP: espere um pouco entre rodadas seguidas.
