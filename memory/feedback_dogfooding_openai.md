---
name: dogfooding uses OpenAI
description: Dogfooding時はOpenAI（gpt-4o-mini + openai_codex_cli）で実行する。claude_apiアダプタは使わない
type: feedback
---

DogfoodingではOpenAIのAIを使ってMotivaを回す。`--adapter claude_api`を指定しない。

**Why:** claude_apiアダプタはLLM APIを呼んでテキストを返すだけで、ファイル作成等の実行ができない。openai_codex_cliアダプタは実際にシェルコマンドを実行できるため、タスクが実行に反映される。

**How to apply:** dogfooding実行時は`--adapter`フラグを省略するか`--adapter openai_codex_cli`を明示する。`provider.json`のデフォルトが`openai_codex_cli`なので省略でOK。claude_apiやclaude_code_cliは使わない。
