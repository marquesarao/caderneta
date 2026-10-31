# Caderneta — despesas da casa

App instalável pelo navegador (PWA) para lançar despesas em dois celulares Android.
Funciona offline e sincroniza com uma planilha Google pela conta `dele.family.2026`.

## Como funciona

- **App** (esta pasta): HTML/CSS/JS puros, sem build. Publicado no GitHub Pages.
- **Dados no celular**: IndexedDB. Lança offline; envia quando houver internet.
- **Planilha `despesas.family`**: base consolidada (abas `Lançamentos` e `Categorias`).
- **`apps-script/Codigo.gs`**: o script colado na planilha (cópia versionada aqui).
  Ao mudar o script, cole de novo no editor e faça **Implantar → Gerenciar implantações → Editar → Nova versão** (a URL continua a mesma).

Regras de sincronização:
- Cada lançamento tem `id` único, `alteradoEm` e `excluido` (nada é apagado de verdade).
- Por `id`, vence a alteração mais recente.
- O celular guarda um cursor (`servidorEm`) e só baixa o que mudou desde a última vez.
- Valores: centavos no celular, reais na planilha.

## Arquivos

| Arquivo | Papel |
|---|---|
| `index.html` | Telas (configuração, Lançar, Mês, Painel/Metas/Relatório, Ajustes) |
| `styles.css` | Visual (claro e escuro) |
| `core.js` | Lógica pura: parcelas, datas, regras de sync, importação |
| `app.js` | Interface, IndexedDB e chamadas à planilha |
| `sw.js` | Service worker: offline e atualização automática |
| `manifest.webmanifest`, `icons/` | Instalação como app |
| `apps-script/Codigo.gs` | Script da planilha |

## Publicar (GitHub Pages)

1. No GitHub, crie um repositório **público** (ex.: `caderneta`). Pages grátis exige repositório público.
   Só o código vai para lá; dados e chave nunca entram no repositório.
2. Nesta pasta:
   ```
   git init
   git add .
   git commit -m "Caderneta v1"
   git branch -M main
   git remote add origin https://github.com/<seu-usuario>/caderneta.git
   git push -u origin main
   ```
3. No repositório: **Settings → Pages → Build and deployment → Source: Deploy from a branch → Branch: main / (root) → Save**.
4. Em 1–2 minutos o app fica em `https://<seu-usuario>.github.io/caderneta/`.

## Instalar nos celulares

1. Abra o endereço no **Chrome** do Android.
2. Menu ⋮ → **Adicionar à tela inicial** → **Instalar**.
3. Na primeira abertura: cole a URL `/exec` do script, a chave da casa e o nome de quem usa o celular.
   A URL e a chave estão no Apps Script (rodar `setup` mostra a chave no log).

## Atualizar o app

Altere os arquivos, faça commit e push. Os celulares pegam a versão nova na próxima abertura com internet.
Ao mudar arquivos, aumente `VERSAO` em `sw.js` (ex.: `caderneta-v2`) para limpar o cache antigo.

## Trazer os dados da Caderneta (artefato do Claude)

Na Caderneta antiga: Ajustes → Exportar **JSON**. No app novo: Ajustes → **Importar da Caderneta (JSON)**.
Faça a importação em **um só celular**; o outro recebe pela sincronização.
