---
title: 'Weighted Canary Routing — safely applying changes on Gateway API HTTPRoutes with EnvoyPatchPolicy'
description: 'Uma abordagem simples de canário probabílistico para GatewayAPI HTTPRoutes usando EnvoyPatchPolicies'
pubDate: 2026-08-09
tags: ['lua', 'SRE', 'Envoy']
draft: false
---

Precisamos andar cada vez mais rápido, e cair cada vez menos. Esse é o paradoxo de viver na era da velocidade — algo que, apesar de ligeiramente (ligeiramente mesmo?) incômodo, é uma realidade contra a qual não tenho poderes para lutar.

Todos já ouvimos falar sobre canários, A/B, entre outros mecanismos que ajudam nisso. Neste blog post, investigaremos uma proposta de canário para HTTPRoutes de Gateway API, uma ideia que eu e um colega (um grande amigo para dizer a verdade) tivemos, onde usamos um pouco de probabilidade matemática, alguns recursos nativos do Envoy, e um pouco de Lua.

É válido dizer de antemão que o objetivo está longe de ser uma solução pronta para qualquer caso (especialmente em produção), mas sim, trazer o raciocínio e ideia, que espero que possa adicionar um pouco de criatividade no dia a dia de quem estiver lendo.

## GatewayAPI & HTTP Routes & Envoy

Se você trabalha com Kubernetes, muito provavelmente já está familiarizado — ou conhece profundamente — o Gateway API, sucessor do famoso (famigerado?) Ingress. Não tenho a pretensão de explicar detalhadamente seu funcionamento, então vamos manter no simples.

Gateway API é um conjunto de APIs do Kubernetes que especificam como expor aplicações, através de abstrações que isolam semanticamente partes dessa exposição. Em linhas gerais, 3 objetos que precisamos ter em mente:

- **GatewayClass**: Configuração compartilhada entre gateways, vinculada a um controlador que a implementa. No nosso caso, o Envoy Gateway controller.
- **Gateway**: Recurso que referencia uma GatewayClass e resulta em instâncias do data plane — no nosso caso, pods Envoy gerenciando o tráfego.
- **HTTPRoute**: Regras que mapeiam tráfego HTTP chegando a um Gateway para serviços upstream no cluster.

Temos também um quarto objeto, GRPCRoute, que em linhas gerais faz o mesmo que HTTPRoute, mas para tráfego gRPC, mas ele não é objeto dessa discussão, então deixaremos ele de lado.

O diagrama abaixo ilustra, de maneira extremamente simplificada, como eles se relacionam:

```ascii
GatewayClass ──── "quem implementa" ───▶ Envoy Gateway controller
     │
     │ gatewayClassName
     ▼
  Gateway ──── "o que roda" ───────────▶ Pods Envoy
     │
     │ parentRef
     ▼
HTTPRoute ──── "pra onde vai" ─────────▶ Service upstream
```

Para mais detalhes de cada um desses objetos e funcionamento do GatewayAPI, recomendo a leitura da [documentação oficial](https://kubernetes.io/docs/concepts/services-networking/gateway/).

## Onde as coisas podem dar errado

Suponhamos que temos o seguinte fluxo, extremamente simples:

```ascii
client
  │
  │  GET /api/v1/users
  ▼
┌────────────────────────────────────────┐
│  Gateway (listeners: HTTPS :443)       │
└───────────────────┬────────────────────┘
                    │
                    │  match: path=/api/v1/users
                    ▼
┌────────────────────────────────────────┐
│  HTTPRoute                             │
│    parentRef:  gateway                 │
│    match:      PathPrefix /api/v1/users│
│    backendRef: users-svc:8080          │
└───────────────────┬────────────────────┘
                    │
                    ▼
┌────────────────────────────────────────┐
│  Service: users-svc                    │
│    ┌─────┐  ┌─────┐  ┌─────┐           │
│    │pod-0│  │pod-1│  │pod-2│           │
│    └─────┘  └─────┘  └─────┘           │
└────────────────────────────────────────┘
```

Temos um serviço que é exposto por uma HTTPRoute, com o path especificado `/api/v1/users` (podemos ignorar o hostname aqui) e um serviço que espera suas requisições nesse path. Bem simples? O que poderia dar errado, não é mesmo? Bom, as coisas sempre podem dar errado. Qualquer mudança nesse serviço, se não aplicarmos mudanças progressivas, podem ser extremamente destrutivas, mas temos diversos mecanismos na comunidade (inclusive no próprio Envoy) que permitem canário, A/B, balanceamento e etc. Então vamos assumir (um grande salto de fé) que temos essa camada protegida.

Mas se nos atentarmos ao diagrama, o HTTPRoute também é um ponto de falha, onde qualquer mudança pode também ter grandes impactos destrutivos. A configuração mais simples para esse objeto seria:

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: users-route
  namespace: default
spec:
  parentRefs:
    - name: gateway
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /api/v1/users
      backendRefs:
        - name: users-svc
          port: 8080
```

Podemos imaginar alguns cenários catastróficos, aqui. Uma mudança de path `/api/v2/users` que o serviço não está preparado para receber. Um typo em `users-svc`, isso sem contar as inúmeras configurações adicionais que um objeto HTTPRoute pode ter em um ambiente produtivo:

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: users-route
  namespace: default
spec:
  parentRefs:
    - name: gateway
  hostnames:
    - "api.example.com"
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /api/v1/users
          headers:
            - name: x-api-version
              value: "v1"
      filters:
        - type: RequestHeaderModifier
          requestHeaderModifier:
            add:
              - name: x-request-source
                value: gateway
            remove:
              - x-internal-debug
        - type: ResponseHeaderModifier
          responseHeaderModifier:
            set:
              - name: x-served-by
                value: envoy
      backendRefs:
        - name: users-svc
          port: 8080
          weight: 100
      timeouts:
        request: 10s
        backendRequest: 5s
```

Algo mais próximo de um ambiente produtivo, como o exemplo acima, dá um vislumbre de como as coisas podem dar errado.

## O que fazer com as HTTPRoutes?

Acredito que agora temos um solo comum onde um ponto tão sensível precisa de mecanismos protetivos condizentes com o tamanho da sua importância. Em um cenário de novos fluxos, talvez erros sejam toleráveis, mas uma API crítica, muitas vezes desconhecida, bom, não preciso explicar novamente onde as coisas podem dar errado, certo?

Apesar de vários mecanismos para proteger como tráfego vai até o serviço upstream, não temos na especificação do GatewayAPI nada que proteja as HTTPRoutes em si. Estamos largados ao nosso próprio destino.

Mas sendo engenheiros, sempre podemos pensar ou bolar uma solução criativa (às vezes demais?) para contornar nossas limitações. EnvoyPatchPolicies, seu momento chegou!

## Envoy ExtensionPolicies & PatchPolicies

Como eu comentei anteriormente focaremos no EnvoyGateway durante esse exercício, então se você estiver com outro controlador, isso exigirá um de-para para objetos da tecnologia.

Com EnvoyGateway, alguns objetos são responsáveis por fazer mutações no comportamento das requisições, dois dos quais são interessantes para o nosso problema:

- **Envoy [ExtensionPolicies](https://gateway.envoyproxy.io/docs/api/extension_types/#extensionpolicy)**: Forma idiomática de injetar lógica custom (Lua, Wasm, ext_proc) com API tipada e validada. É a forma mais recomendada de se fazer mudanças, pois basicamente precisamos satisfazer uma API de alto nível do Envoy que mutaria as requisições, sendo esse já um guard rail para garantir que as mudanças não terão efeitos colaterais. Elas podem ser aplicadas em objetos de Gateway e HTTPRoutes.
- **Envoy [PatchPolicies](https://gateway.envoyproxy.io/docs/api/extension_types/#envoypatchpolicy)**: Escape hatch do Envoy Gateway. Aplica JSON Patches diretamente no xDS (a configuração que o Envoy consome em runtime) — controle total, sem validação semântica. Um patch errado pode quebrar o data plane. Você, um JSON e um sonho.

Na prática, a diferença é: com ExtensionPolicies o risco de impactar o data plane é extremamente baixo. Com PatchPolicies estamos literalmente aplicando um patch direto no xDS que será usado no data plane, sem qualquer validação de alto nível.

Então, como estamos mirando em resiliência, parece que temos uma escolha óbvia, correto?

Não tão rápido.

ExtensionPolicies têm uso extremamente amplo, inclusive para mutações específicas de uma única HTTPRoute que não fazem sentido para as demais. Mas o que realmente nos atrapalha: elas seguem um comportamento de hierarquia de especificidade. Ele sempre aplicará a configuração mais específica. Se aplicarmos uma ExtensionPolicy no Gateway e, posteriormente, precisarmos aplicar um plugin Wasm em uma HTTPRoute específica, a ExtensionPolicy do Gateway será desconsiderada para aquela rota — aplicando somente a do nível mais específico (a da HTTPRoute).

E como queremos que isso seja um comportamento padrão de todas as HTTPRoutes, não temos alternativa.

## Envoy PatchPolicies - Aqui vamos nós

Diferentemente das ExtensionPolicies, as PatchPolicies atuam diretamente no objeto xDS final que os proxies do Envoy receberão, como podemos ver no [código](https://github.com/envoyproxy/gateway/blob/main/internal/xds/translator/translator.go#L161-L178):

```go
// Patch global resources that are shared across listeners and routes.
if err := t.patchGlobalResources(tCtx, xdsIR); err != nil {
	return nil, err
}

// All XDS resources is ready, let's do the patch.
if err := processJSONPatches(tCtx, xdsIR.EnvoyPatchPolicies); err != nil {
	t.Logger.Error(err, "Failed to process JSON patches")
}

// Check if an extension want to modify the generated xDS resources
if err := processExtensionPostTranslationHook(tCtx, t.ExtensionManager, xdsIR.ExtensionServerPolicies); err != nil {
	if !(*t.ExtensionManager).FailOpen() {
		return nil, err
	}
	t.Logger.Error(err, "Extension Manager PostTranslation failure")
}
```

Em outras palavras, depois que o controller (Envoy Gateway) montar toda a configuração final — onde já processou todos os parâmetros de configuração, incluindo ExtensionPolicies — ele aplicará o patch no objeto xDS resultante.

Com isso resolvemos nosso problema: aplicamos uma PatchPolicy no Gateway, que mutará o xDS para todas as HTTPRoutes abaixo dele, garantindo que cada rota possa manter seus comportamentos específicos (ExtensionPolicies próprias) sem perder o filtro de canário que queremos introduzir por padrão.

Antes de seguirmos, gostaria de agradecer a paciência, e temos um último ponto que é cobrir a anatomia de uma PatchPolicy

```yaml
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: EnvoyPatchPolicy
metadata:
  name: add-hello-custom-header
  namespace: default
spec:
  targetRef:
    group: gateway.networking.k8s.io
    kind: Gateway
    name: gateway
  type: JSONPatch
  jsonPatches:
    - type: "type.googleapis.com/envoy.config.listener.v3.Listener"
      name: "default/gateway/https"
      operation:
        op: add
        path: "/default_filter_chain/filters/0/typed_config/http_filters/0"
        value:
          name: "envoy.filters.http.lua.add-header"
          typed_config:
            "@type": "type.googleapis.com/envoy.extensions.filters.http.lua.v3.Lua"
            default_source_code:
              inline_string: |
                function envoy_on_request(handle)
                  handle:headers():add("x-custom-header", "hello-from-patch")
                end
```

Não vamos entrar em todos os detalhes da especficação aqui — a [documentação oficial](https://gateway.envoyproxy.io/docs/tasks/extensibility/envoy-patch-policy/) cobre isso bem. Para a nossa atual jornada, 4 campos são os mais importantes:

- `targetRef`: Para onde o patch aponta. No nosso caso, o objeto Gateway — garantindo que o patch afete todas as HTTPRoutes abaixo dele (poderíamos mudar para uma HTTPRoute em específico, mas como queremos para todas mantemos assim).
- `jsonPatches[].name`: O nome do recurso xDS que receberá o patch, no formato `{namespace}/{gateway}/{listener}`. Se esse nome não corresponder a um recurso existente, o patch silenciosamente não será aplicado.
- `jsonPatches[].operation.path`: O JSON Pointer que define onde no objeto xDS a modificação será feita. É aqui que mora o risco — um path errado pode injetar configuração no lugar errado ou sobrescrever algo crítico.
- `default_source_code.inline_string`: Onde colocamos o código Lua que será executado em toda request. É aqui que viverá a lógica do nosso canário — inline, diretamente no YAML da PatchPolicy. No exemplo acima ele não parece fazer muita coisa, certo? Estamos simplesmente adicionando um header com valor `hello-from-patch` em todas as requests. Mas pensando bem... será que estamos longe da solução para a nossa jornada?

## Finalmente, o canário

Agora que temos um ground work bem sólido (espero que tenha conseguido esclarecer minimamente) vamos a solução.

A ideia é relativamente simples, e como vimos na outra seção tem a ver com headers. Para uma request dar match com uma HTTPRoute, ela precisa satisfazer as condições de host e qualquer outra especificação que esteja no campo `rules`, ou seja um path e um header. Nenhum mistério até aqui.

Então basicamente, como podemos apontar múltiplas HTTPRoutes, para o mesmo upstream, toda a nossa estratégia de canário consiste em criamos HTTPRoutes identicas em si, com a exceção de um header que identificaria o peso do tráfego que ela deve receber.

Vamos deixar isso mais claro, pegando o nosso exemplo anterior:

<div class="side-by-side">

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: users-route-canary-2
  namespace: default
spec:
  parentRefs:
    - name: gateway
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /api/v1/users
          headers:
            - name: x-canary
              value: "2"
      backendRefs:
        - name: users-svc
          port: 8080
```

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: users-route-canary-25
  namespace: default
spec:
  parentRefs:
    - name: gateway
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /api/v1/users
          headers:
            - name: x-canary
              value: "25"
      backendRefs:
        - name: users-svc
          port: 8080
```

</div>

Ou seja, basicamente a nossa ideia é que a HTTPRoute `users-route-canary-2` receba 2% das requests e a rota `users-route-canary-25` receba 25%. E note como ambas tem o mesmo `backendRefs` (upstream), temos aqui uma estratégia para dividirmos isso de maneira segura. Por ora, como dito no começo do post, assumiremos que não precisamos de nenhum tipo de stickness ou que ele está implementado em outra camada.

Em resumo, criando HTTPRoutes que apenas diferem no header de peso, conseguimos aplicar mudanças iniciais para apenas 2%, depois 25%, etc, você entendeu a ideia. Mas temos um problema, dado que precisamos desse header antes de HTTPRoute ser processada, como podemos injetar ele dinamicamente e reprocessar a HTTPRoute?

## Um pouco de matemática não mata ninguém

Como o título mencionou anteriormente, a ideia é termos um canário probabilístico. Mas até agora não falamos nada de probabilidade, não é mesmo?

Vamos lá.

Considere o conjunto `U = {1, 2, 3, ..., 100}`. Podemos dividir U em subconjuntos menores que não se sobrepõem:

```ascii
A₁ = {1}                → 1 elemento   → 1% de tamanho
A₂ = {2, 3}             → 2 elementos  → 2% de tamanho
A₃ = {4, ..., 10}       → 7 elementos  → 7% de tamanho
A₄ = {11, ..., 25}      → 15 elementos → 15% de tamanho
A₅ = {26, ..., 50}      → 25 elementos → 25% de tamanho
A₆ = {51, ..., 100}     → 50 elementos → 50% de tamanho
```

Se sortearmos um número aleatório com `math.random(100)`, a probabilidade dele cair em um subconjunto é simplesmente o mesmo do tamanho desse subconjunto:

```ascii
P(n ∈ Aᵢ) = tamanho do subconjunto / 100
```

Quanto maior o subconjunto, maior a chance. Um grupo com 50 elementos = 50% de chance. Um grupo com 1 elemento = 1%.

Peço desculpas pelas notações matemáticas, espero que não tenha ficado muito confuso (estou tentando deixar minha mãe orgulhosa aqui, ok).

A ideia é simplesmente pensar que isso não é um simples conjunto, mas sim o conjunto das requests, que estamos processando!

Basicamente, para cada request que chegar, precisamos calcular esse valor randomico, e com base no numero sorteado, ele cai em um grupo prefinido, e marcamos a request com o header de peso que esse número corresponde.

**Importante**: os subconjuntos precisam cobrir todos os números de 1 a 100, sem buracos. Se algum número não pertencer a nenhum grupo, a request que sortear esse número escapará do canário silenciosamente. E como estamos falando de probabilidade calculada em tempo de voo, não temos o conjunto das requests de antemão — então a proporção nunca é exata. Em baixo volume a variação é grande (com 100 requests, uma coorte de 2% pode não receber nenhuma), e ela converge conforme o tráfego cresce. Mas para os nossos fins, isso é preciso o suficiente.

Agora so precisamos de um mecanismo para calcular isso e adicionar esses valores e marcarmos as requests com os headers de pesado. PatchPolicies, já estávamos com saudade.

## Costurando tudo de uma vez

Por fim, o que precisamos é de uma Envoy PatchPolicy, aplicada a nível de Gateway, que sempre calculará uma probabilidade/peso para aquela request, adicionará o header que estipularmos, e dará match com as HTTPRoutes que vamos criar.

Comecemos pela PatchPolicy:

```yaml
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: EnvoyPatchPolicy
metadata:
  name: canary-cohort-patch
  namespace: default
spec:
  targetRef:
    group: gateway.networking.k8s.io
    kind: Gateway
    name: gateway
  type: JSONPatch
  jsonPatches:
    - type: "type.googleapis.com/envoy.config.listener.v3.Listener"
      name: "default/gateway/https"
      operation:
        op: add
        path: "/default_filter_chain/filters/0/typed_config/http_filters/0"
        value:
          name: "envoy.filters.http.lua.canary-cohort"
          typed_config:
            "@type": "type.googleapis.com/envoy.extensions.filters.http.lua.v3.Lua"
            default_source_code:
              inline_string: |
                function envoy_on_request(handle)
                  local n = math.random(100)
                  local label

                  if n <= 1 then
                    label = "1"
                  elseif n <= 3 then
                    label = "2"
                  elseif n <= 10 then
                    label = "7"
                  elseif n <= 25 then
                    label = "15"
                  elseif n <= 50 then
                    label = "25"
                  else
                    label = "50"
                  end

                  handle:headers():add("x-canary", label)
                  handle:clearRouteCache()

                end
```

Basicamente o que temos de novo é o código Lua, que como explicamos na seção anterior vai sortear um número no conjunto de 1 a 100, e com base no número cairá em uma das condições do código, que representa os subconjuntos que mapeamos, que correspondem ao peso do canário que queremos para a rota em específico. Note que os pesos dos canários foram arbitrariamente selecionados para contemplar 1%,2%,7%,15%,25%,50% do tráfego, mas poderíamos ter alterado esses valores conquanto que a somatória desse 100. Depois do cálculo e da definição da variável label, adicionamos o header e chamamos o método `handle:clearRouteCache()` que é responsável por dizer ao envoy reprocessar a request, e garantir que ela agora contenha o header de canário.

Sobre esse último ponto, vale uma ressalva: `clearRouteCache()` é opcional aqui. O filtro Lua tem a opção `clear_route_cache`, que já vem como `true` por padrão e limpa o cache sozinha sempre que o script modifica headers de request. Deixei a chamada explícita porque o reprocessamento é justamente o coração da solução, e prefiro que isso esteja visível no código a depender de um default — mas se você omitir, continua funcionando.

E aqui mora uma armadilha bem menos simpática. Em Lua, `math.random` sem semente devolve sempre a mesma sequência, e o Envoy cria um estado Lua **por worker thread**. Ou seja: sem `math.randomseed()`, todos os workers sorteiam os mesmos números, na mesma ordem, desde a primeira request — e a sequência se repete a cada restart do proxy. O pior é que parece estar funcionando, porque os labels variam normalmente. Você só descobre quando compara as proporções entre dois pods e encontra exatamente a mesma distribuição.

A correção é adicionar seeds uma vez por estado Lua. Código fora de `envoy_on_request` roda uma única vez, quando o worker carrega o script:

```lua
math.randomseed(os.time() + tonumber(tostring({}):match("0x(.*)"), 16))

function envoy_on_request(handle)
  -- resto do código
end
```

O truque está no `tostring({})`: ele devolve algo como `table: 0x7f3a2b4c`, e esse hexadecimal é o endereço onde aquela tabela temporária foi alocada no heap. Mas vale separar de onde vem a variação, porque são dois mecanismos diferentes:

Entre **processos** — pods distintos, ou o mesmo pod reiniciado — quem garante que o endereço mude é o **[ASLR](https://documentation.ubuntu.com/security/security-features/process-memory/aslr/)**. O kernel randomiza o layout do espaço de endereçamento a cada execução, então o mesmo binário rodando o mesmo código aloca em lugares diferentes toda vez.

Entre **workers do mesmo processo**, o ASLR não ajuda em nada: threads compartilham um único espaço de endereçamento, randomizado uma vez só na subida. O que separa os workers ali é o [alocador](https://github.com/LuaJIT/LuaJIT/blob/v2.1/src/lj_alloc.c) — cada estado Lua pede sua própria região de memória, e elas caem em offsets distintos.

Ainda assim, estamos falando de heurística — e o quanto ela funciona depende do build do LuaJIT. O [`lj_alloc.c`](https://github.com/LuaJIT/LuaJIT/blob/v2.1/src/lj_alloc.c) define quanto do espaço de endereçamento o alocador pode usar:

```c
#if LJ_GC64
#define LJ_ALLOC_MBITS		47	/* 128 TB in LJ_GC64 mode. */
#elif LJ_TARGET_X64
/* Due to limitations in the x64 non-GC64 VM. */
#define LJ_ALLOC_MBITS		31	/* 2 GB on x64 with !LJ_GC64. */
#else
#define LJ_ALLOC_MBITS		32	/* 4 GB on other archs with !LJ_GC64. */
#endif
```

Com GC64 — padrão no x86_64 desde 2019 — são 47 bits de espaço e o endereço tem entropia de sobra. Sem GC64, o LuaJIT fica confinado a 31 bits no x64, apenas 2 GB, e a variação cai muito. Vale conferir com qual build o seu Envoy foi compilado antes de confiar demais no truque.

Há também um detalhe que ajuda: nem toda a variação vem do kernel. Quando o `mmap` devolve um endereço fora do limite permitido, o `mmap_probe` tenta de novo usando um palpite pseudoaleatório do PRNG interno do próprio LuaJIT (`lj_prng_u64`). Ou seja, parte da entropia é do LuaJIT, não do ASLR.

Mesmo assim, a dependência do ASLR tem uma ressalva: num ambiente que rode com randomização desabilitada (por favor não faça isso, se você preza por segurança, um assunto para outro blogpost com certeza), o endereço vira praticamente constante e você volta ao problema original.

Espere um pouco... parece que realmente saímos do foco um pouco aqui, não é mesmo? Peço perdão pelo desvio, voltemos ao assunto do post

Agora quando temos a HTTPRoute abaixo, ela dará match quando a proporção do tráfego receber o header correspondente com a sua configuração:

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: users-route-canary-25
  namespace: default
spec:
  parentRefs:
    - name: gateway
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /api/v1/users
          headers:
            - name: x-canary
              value: "25"
      backendRefs:
        - name: users-svc
          port: 8080
```

Esse exemplo é para 25%, mas poderíamos criar as demais HTTPRoutes com os demais pesos. Você deve estar se perguntando o que acontece quando não tenho uma HTTPRoute com match do header `x-canary`, não é mesmo? Ela simplesmente não dará match, e a request entrará na HTTPRoute padrão — aquela do começo do post, que só exige o path.

E quando as duas casam? Uma request com `x-canary: 25` satisfaz tanto a rota de canário (path + header) quanto a rota padrão (só path). Aqui não há ambiguidade nem sorte: a especificação do Gateway API define precedência por especificidade, e um dos critérios é o **maior número de matches de header**. Por isso a rota de canário sempre ganha da padrão quando o header está presente — e é exatamente esse detalhe da spec que faz todo o mecanismo funcionar.

Só não esqueça de manter a rota padrão no cluster. Como o Lua carimba **todas** as requests, o tráfego que sortear uma faixa sem rota correspondente precisa de algum lugar para cair. Sem ela, essas requests não casam com nada e recebem 404 — o que, dependendo de quantas faixas você deixou sem rota, pode ser boa parte do seu tráfego. 

## Ressalvas técnicas importantes

Como pontuei no começo do blogpost, temos vários pontos a serem considerados antes de uma adoção em massa, principalmente produtiva:

- **O path do patch é frágil**: O JSON Pointer que usamos — `/default_filter_chain/filters/0/typed_config/http_filters/0` — presume que o HTTP connection manager é o primeiro filtro do filter chain, e insere o Lua na posição 0 da cadeia HTTP. Nada disso é contrato: é o layout que o Envoy Gateway gera hoje. Um upgrade do controller pode reorganizar o xDS e fazer o patch aterrissar no lugar errado, ou simplesmente não aplicar. Trate a versão do Envoy Gateway como dependência da sua PatchPolicy, e valide o canário a cada atualização.
- **EnvoyPatchPolicy vem desabilitado por padrão**: Você precisa habilitar explicitamente o recurso no ConfigMap do Envoy Gateway. Sem isso o objeto é aceito pelo cluster sem reclamação nenhuma e simplesmente não faz nada — o que rende uma boa meia hora de depuração até você desconfiar:

    ```yaml
    extensionApis:
      enableEnvoyPatchPolicy: true
    ```

    E vale saber por que o default é esse: quem tem permissão de criar EnvoyPatchPolicy pode injetar configuração arbitrária no data plane. Num cluster multi-tenant, isso é um problema de RBAC antes de ser um problema de roteamento.
- **Stickness**: Essa estratégia toda está amarrada no fato de que para os clintes do que está exposto, é indiferente em qual HTTPRoute eles caíram, na stable ou em alguma dos canários. Se alguma mudança da rota muda o comportamento esperado, ou se o upstream varia o comportamento também, uma estratégia de stickness precisa ser implementada para garantir um comportamento homogeneo para o cliente
- **Headers em todas as requests**: Independente de seu fluxo ter ou não HTTPRoutes de canário, com a nossa abordagem aplicaremos o header em **todas** as requests. Caso header adicional seja um problema no seu fluxo (diversos hops da jornada podem estourar por tamanho de headers), considere adicionar em outros pontos da infraestrutura.
- **Análise estática**: Temos excelentes soluções que poderiam fazer validações de configuração estática de uma maneira muito mais eficiente e mais testada, como Kyverno ou Gatekeeper. Mas elas falham quando precisamos validar semanticamente, ou mudanças que estaticamente estão corretas mas o cenário é incerto. O exemplo do começo do post ilustra bem: trocar o path para `/api/v2/users` é sintaticamente perfeito, passa em qualquer schema, e ainda assim derruba todo o tráfego.
