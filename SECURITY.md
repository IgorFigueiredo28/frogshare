# Segurança

## Como reportar uma vulnerabilidade

**Não abra uma issue pública.** Use o reporte privado do GitHub: aba **Security › Report a vulnerability** deste repositório.

Inclua, se puder:
- o que dá para fazer com a falha (por exemplo, tomar uma sala, ler dados ou derrubar o serviço);
- como reproduzir, passo a passo;
- a versão do app ou o endereço afetado.

Respondemos pelo próprio reporte e avisamos quando a correção for publicada.

## O que está no escopo

- O app FrogShare (Windows e macOS) na versão mais recente.
- O servidor e o site em `frogshare.onrender.com`.

Fora do escopo: ataques de negação de serviço por volume, engenharia social e falhas em serviços de terceiros (Cloudflare, Render, Supabase, Google Drive). Falhas nesses serviços devem ser reportadas a eles.

## Segredos

Nenhuma chave fica no código. Se você encontrar uma credencial válida neste repositório ou no histórico dele, reporte pelo canal acima.
