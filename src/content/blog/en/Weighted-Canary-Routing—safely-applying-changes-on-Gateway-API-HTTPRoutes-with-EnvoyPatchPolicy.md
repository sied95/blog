---
title: 'Weighted Canary Routing — safely applying changes on Gateway API HTTPRoutes with EnvoyPatchPolicy'
description: 'A simple probabilistic canary approach for Gateway API HTTPRoutes using EnvoyPatchPolicies'
pubDate: 2026-08-09
tags: ['lua', 'SRE', 'Envoy']
draft: false
---

We need to move faster and faster, and fall over less and less. That's the paradox of living in the age of speed — something that, however mildly (mildly, really?) uncomfortable, is a reality I have no power to fight.

We've all heard about canaries, A/B, and other mechanisms that help with this. In this blog post we'll investigate a canary proposal for Gateway API HTTPRoutes, an idea a colleague and I came up with (a close friend, to be honest), using a bit of probability, some native Envoy features, and a little Lua.

It's worth saying upfront that the goal is far from being a solution ready for every case (especially in production) — it's to share the reasoning and the idea, which I hope adds a bit of creativity to the day-to-day of whoever is reading.

## GatewayAPI & HTTP Routes & Envoy

If you work with Kubernetes, you're very likely already familiar with — or know deeply — the Gateway API, successor to the famous (infamous?) Ingress. I don't intend to explain how it works in detail, so let's keep it simple.

Gateway API is a set of Kubernetes APIs that specify how to expose applications, through abstractions that semantically isolate parts of that exposure. Broadly speaking, there are 3 objects we need to keep in mind:

- **GatewayClass**: Shared configuration across gateways, bound to a controller that implements it. In our case, the Envoy Gateway controller.
- **Gateway**: A resource that references a GatewayClass and results in data plane instances — in our case, Envoy pods handling the traffic.
- **HTTPRoute**: Rules that map HTTP traffic arriving at a Gateway to upstream services in the cluster.

There's also a fourth object, GRPCRoute, which broadly does the same as HTTPRoute but for gRPC traffic. It isn't the subject of this discussion, so we'll set it aside.

The diagram below illustrates, in an extremely simplified way, how they relate to each other:

```ascii
GatewayClass ──── "who implements it" ──▶ Envoy Gateway controller
     │
     │ gatewayClassName
     ▼
  Gateway ──── "what runs" ─────────────▶ Envoy pods
     │
     │ parentRef
     ▼
HTTPRoute ──── "where it goes" ─────────▶ upstream Service
```

For more detail on each of these objects and on how the Gateway API works, I recommend reading the [official documentation](https://kubernetes.io/docs/concepts/services-networking/gateway/).

## Where things can go wrong

Suppose we have the following, extremely simple flow:

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

We have a service exposed by an HTTPRoute, with the path set to `/api/v1/users` (we can ignore the hostname here) and a service expecting its requests on that path. Simple enough? What could go wrong, right? Well, things can always go wrong. Any change to this service, if we don't apply changes progressively, can be extremely destructive — but we have plenty of mechanisms in the community (including in Envoy itself) that enable canary, A/B, load balancing, and so on. So let's assume (a big leap of faith) that this layer is protected.

But if we look closely at the diagram, the HTTPRoute is also a point of failure, where any change can likewise have large destructive impacts. The simplest configuration for this object would be:

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

We can imagine a few catastrophic scenarios here. A path change to `/api/v2/users` that the service isn't prepared to receive. A typo in `users-svc`. And that's without counting the countless additional settings an HTTPRoute object can carry in a production environment:

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

Something closer to a production environment, like the example above, gives a glimpse of how things can go wrong.

## What do we do about HTTPRoutes?

I believe we now have common ground that a point this sensitive needs protective mechanisms proportional to how important it is. In a scenario of brand-new flows, maybe mistakes are tolerable — but for a critical API, often one nobody fully understands, well, I don't need to explain again where things can go wrong, right?

Despite the many mechanisms for protecting how traffic reaches the upstream service, there is nothing in the Gateway API specification that protects the HTTPRoutes themselves. We're left to our own devices.

But being engineers, we can always come up with a creative solution (too creative, sometimes?) to work around our limitations. EnvoyPatchPolicies, your moment has come!

## Envoy ExtensionPolicies & PatchPolicies

As I mentioned earlier, we'll focus on Envoy Gateway for this exercise, so if you're running a different controller this will require mapping the concepts onto that technology's objects.

With Envoy Gateway, a few objects are responsible for mutating request behavior, two of which are interesting for our problem:

- **Envoy [ExtensionPolicies](https://gateway.envoyproxy.io/docs/api/extension_types/#extensionpolicy)**: The idiomatic way to inject custom logic (Lua, Wasm, ext_proc) with a typed, validated API. It's the most recommended way to make changes, because we essentially have to satisfy a high-level Envoy API that would mutate the requests — which is itself a guard rail ensuring the changes won't have side effects. They can be applied to Gateway and HTTPRoute objects.
- **Envoy [PatchPolicies](https://gateway.envoyproxy.io/docs/api/extension_types/#envoypatchpolicy)**: Envoy Gateway's escape hatch. It applies JSON Patches directly to the xDS (the configuration Envoy consumes at runtime) — total control, no semantic validation. A wrong patch can break the data plane. You, a JSON document, and a dream.

In practice, the difference is: with ExtensionPolicies the risk of impacting the data plane is extremely low. With PatchPolicies we are literally applying a patch straight into the xDS that will be used by the data plane, without any high-level validation.

So, since we're aiming for resilience, it looks like we have an obvious choice, right?

Not so fast.

ExtensionPolicies have an extremely broad range of uses, including mutations specific to a single HTTPRoute that make no sense for the others. But here's what actually gets in our way: they follow a specificity hierarchy. The most specific configuration always wins. If we apply an ExtensionPolicy at the Gateway and later need to apply a Wasm plugin to a specific HTTPRoute, the Gateway's ExtensionPolicy will be disregarded for that route — only the most specific level (the HTTPRoute's) gets applied.

And since we want this to be default behavior across every HTTPRoute, we have no alternative.

## Envoy PatchPolicies — here we go

Unlike ExtensionPolicies, PatchPolicies act directly on the final xDS object that the Envoy proxies will receive, as we can see in the [source](https://github.com/envoyproxy/gateway/blob/main/internal/xds/translator/translator.go#L161-L178):

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

In other words, once the controller (Envoy Gateway) has assembled the entire final configuration — having already processed every configuration parameter, ExtensionPolicies included — it applies the patch to the resulting xDS object.

That solves our problem: we apply a PatchPolicy at the Gateway, which mutates the xDS for every HTTPRoute underneath it, ensuring each route can keep its own specific behaviors (its own ExtensionPolicies) without losing the canary filter we want to introduce by default.

Before we move on, I'd like to thank you for your patience — and there's one last point to cover: the anatomy of a PatchPolicy

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

We won't go into every detail of the spec here — the [official documentation](https://gateway.envoyproxy.io/docs/tasks/extensibility/envoy-patch-policy/) covers that well. For our current journey, 4 fields matter most:

- `targetRef`: Where the patch points. In our case, the Gateway object — making sure the patch affects every HTTPRoute underneath it (we could point it at a specific HTTPRoute, but since we want it for all of them, we keep it this way).
- `jsonPatches[].name`: The name of the xDS resource that will receive the patch, in the format `{namespace}/{gateway}/{listener}`. If this name doesn't match an existing resource, the patch silently won't be applied.
- `jsonPatches[].operation.path`: The JSON Pointer defining where in the xDS object the modification will be made. This is where the risk lives — a wrong path can inject configuration in the wrong place or overwrite something critical.
- `default_source_code.inline_string`: Where we put the Lua code that will run on every request. This is where our canary logic will live — inline, right in the PatchPolicy YAML. In the example above it doesn't seem to do much, right? We're simply adding a header with the value `hello-from-patch` to every request. But come to think of it... are we really that far from the solution to our journey?

## Finally, the canary

Now that we have fairly solid groundwork (I hope I managed to clarify it at least a little), let's get to the solution.

The idea is relatively simple and, as we saw in the previous section, it has to do with headers. For a request to match an HTTPRoute, it has to satisfy the host conditions and any other specification in the `rules` field — that is, a path and a header. No mystery so far.

So basically, since we can point multiple HTTPRoutes at the same upstream, our whole canary strategy consists of creating HTTPRoutes that are identical to one another, except for a header that would identify the weight of the traffic each one should receive.

Let's make this clearer by taking our earlier example:

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

In other words, our idea is basically that the HTTPRoute `users-route-canary-2` receives 2% of the requests and the route `users-route-canary-25` receives 25%. And notice how both have the same `backendRefs` (upstream) — here we have a strategy for splitting this safely. For now, as stated at the beginning of the post, we'll assume we don't need any kind of stickiness, or that it's implemented at another layer.

In short, by creating HTTPRoutes that differ only in the weight header, we can roll changes out to just 2% first, then 25%, and so on — you get the idea. But we have a problem: since we need this header before the HTTPRoute is processed, how can we inject it dynamically and have the HTTPRoute reprocessed?

## A little math never hurt anyone

As the title mentioned earlier, the idea is to have a probabilistic canary. But so far we haven't said a word about probability, have we?

Here we go.

Consider the set `U = {1, 2, 3, ..., 100}`. We can split U into smaller subsets that don't overlap:

```ascii
A₁ = {1}                → 1 element   → 1% in size
A₂ = {2, 3}             → 2 elements  → 2% in size
A₃ = {4, ..., 10}       → 7 elements  → 7% in size
A₄ = {11, ..., 25}      → 15 elements → 15% in size
A₅ = {26, ..., 50}      → 25 elements → 25% in size
A₆ = {51, ..., 100}     → 50 elements → 50% in size
```

If we draw a random number with `math.random(100)`, the probability of it landing in a subset is simply the same as the size of that subset:

```ascii
P(n ∈ Aᵢ) = size of the subset / 100
```

The bigger the subset, the higher the chance. A group with 50 elements = 50% chance. A group with 1 element = 1%.

My apologies for the mathematical notation, I hope it didn't get too confusing (I'm trying to make my mother proud here, okay).

The idea is simply to think of this not as a plain set, but as the set of requests we're processing!

Basically, for every incoming request we need to compute that random value, and based on the number drawn it falls into a predefined group — and we tag the request with the weight header that number corresponds to.

**Important**: the subsets need to cover every number from 1 to 100, with no gaps. If some number doesn't belong to any group, the request that draws that number will slip past the canary silently. And since we're talking about probability computed on the fly, we don't have the set of requests up front — so the proportion is never exact. At low volume the variation is large (with 100 requests, a 2% cohort may receive none at all), and it converges as traffic grows. But for our purposes, this is precise enough.

Now we just need a mechanism to compute this, add these values, and tag the requests with the weight headers. PatchPolicies, we've missed you.

## Stitching it all together

In the end, what we need is an Envoy PatchPolicy, applied at the Gateway level, that always computes a probability/weight for that request, adds the header we define, and matches the HTTPRoutes we're going to create.

Let's start with the PatchPolicy:

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

Basically, what's new here is the Lua code which, as we explained in the previous section, draws a number from the set of 1 to 100 and, based on that number, falls into one of the code's conditions — which represent the subsets we mapped, corresponding to the canary weight we want for that specific route. Note that the canary weights were arbitrarily chosen to cover 1%, 2%, 7%, 15%, 25%, and 50% of the traffic, but we could have changed those values as long as they add up to 100. After the calculation and setting the label variable, we add the header and call `handle:clearRouteCache()`, which is responsible for telling Envoy to reprocess the request and ensure it now carries the canary header.

On that last point, a caveat is in order: `clearRouteCache()` is optional here. The Lua filter has a `clear_route_cache` option that already defaults to `true` and clears the cache on its own whenever the script modifies request headers. I left the call explicit because reprocessing is the very heart of the solution, and I'd rather have that visible in the code than rely on a default — but if you omit it, things still work.

And here lies a far less friendly trap. In Lua, `math.random` without a seed always returns the same sequence, and Envoy creates one Lua state **per worker thread**. Which means: without `math.randomseed()`, every worker draws the same numbers, in the same order, from the very first request — and the sequence repeats on every proxy restart. The worst part is that it looks like it's working, because the labels do vary. You only find out when you compare cohorts across two pods and find exactly the same distribution.

The fix is to seed once per Lua state. Code outside `envoy_on_request` runs exactly once, when the worker loads the script:

```lua
math.randomseed(os.time() + tonumber(tostring({}):match("0x(.*)"), 16))

function envoy_on_request(handle)
  -- rest of the code
end
```

The trick is in `tostring({})`: it returns something like `table: 0x7f3a2b4c`, and that hex value is the address where the temporary table was allocated on the heap. But it's worth separating where the variation actually comes from, because these are two different mechanisms:

Across **processes** — different pods, or the same pod restarted — what guarantees the address changes is **[ASLR](https://documentation.ubuntu.com/security/security-features/process-memory/aslr/)**. The kernel randomizes the address space layout on every execution, so the same binary running the same code allocates in different places each time.

Across **workers within the same process**, ASLR doesn't help at all: threads share a single address space, randomized just once at startup. What separates the workers there is the [allocator](https://github.com/LuaJIT/LuaJIT/blob/v2.1/src/lj_alloc.c) — each Lua state requests its own memory region, and those land at distinct offsets.

Even so, we're talking about a heuristic — and how well it works depends on the LuaJIT build. [`lj_alloc.c`](https://github.com/LuaJIT/LuaJIT/blob/v2.1/src/lj_alloc.c) defines how much of the address space the allocator is allowed to use:

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

With GC64 — the default on x86_64 since 2019 — that's 47 bits of space, and the address has entropy to spare. Without GC64, LuaJIT is confined to 31 bits on x64, just 2 GB, and the variation drops sharply. It's worth checking which build your Envoy was compiled with before trusting the trick too much.

There's also a detail that helps: not all the variation comes from the kernel. When `mmap` returns an address outside the allowed range, `mmap_probe` retries using a pseudo-random hint from LuaJIT's own internal PRNG (`lj_prng_u64`). So part of the entropy is LuaJIT's, not ASLR's.

Even so, the dependency on ASLR comes with a caveat: in an environment running with randomization disabled (please don't do this, if you care about security — a topic for another blog post, for sure), the address becomes essentially a constant and you're back to the original problem.

Hold on a second... it really does look like we drifted off topic here, doesn't it? Apologies for the detour — let's get back to the subject of the post

Now, with the HTTPRoute below, it will match whenever that share of the traffic receives the header corresponding to its configuration:

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

This example is for 25%, but we could create the remaining HTTPRoutes with the other weights. You're probably wondering what happens when I don't have an HTTPRoute matching the `x-canary` header, right? It simply won't match, and the request will fall into the default HTTPRoute — the one from the beginning of the post, which only requires the path.

And when both match? A request with `x-canary: 25` satisfies both the canary route (path + header) and the default route (path only). There's no ambiguity or luck here: the Gateway API spec defines precedence by specificity, and one of the criteria is the **largest number of header matches**. That's why the canary route always beats the default one when the header is present — and it's exactly that detail in the spec that makes the whole mechanism work.

Just don't forget to keep the default route in the cluster. Since the Lua stamps **every** request, traffic that draws a band without a corresponding route needs somewhere to land. Without it, those requests match nothing and get a 404 — which, depending on how many bands you left without a route, could be a good chunk of your traffic.

## Important technical caveats

As I pointed out at the beginning of the blog post, there are several points to consider before adopting this broadly, mainly:

- **The patch path is fragile**: The JSON Pointer we used — `/default_filter_chain/filters/0/typed_config/http_filters/0` — assumes the HTTP connection manager is the first filter in the filter chain, and inserts the Lua at position 0 of the HTTP chain. None of that is a contract: it's the layout Envoy Gateway generates today. A controller upgrade can rearrange the xDS and make the patch land in the wrong place, or simply not apply. Treat the Envoy Gateway version as a dependency of your PatchPolicy, and validate the canary on every update.
- **EnvoyPatchPolicy is disabled by default**: You have to explicitly enable the feature in Envoy Gateway's ConfigMap. Without it the object is accepted by the cluster without a single complaint and simply does nothing — which buys you a solid half hour of debugging before you get suspicious:

    ```yaml
    extensionApis:
      enableEnvoyPatchPolicy: true
    ```

    And it's worth knowing why that's the default: anyone with permission to create an EnvoyPatchPolicy can inject arbitrary configuration into the data plane. In a multi-tenant cluster, that's an RBAC problem before it's a routing problem.
- **Stickiness**: This whole strategy is tied to the fact that, for the clients of what's exposed, it makes no difference which HTTPRoute they landed on — the stable one or one of the canaries. If some route change alters the expected behavior, or if the upstream varies its behavior too, a stickiness strategy needs to be implemented to guarantee homogeneous behavior for the client.
- **Headers on every request**: Whether or not your flow has canary HTTPRoutes, our approach applies the header to **every** request. If an additional header is a problem in your flow (several hops along the journey can blow up on header size), consider adding it at other points of the infrastructure.
- **Static analysis**: We have excellent solutions that could validate static configuration far more efficiently and with far more mileage, like Kyverno or Gatekeeper. But they fall short when we need to validate semantically, or for changes that are statically correct while the scenario is uncertain. The example from the beginning of the post illustrates it well: switching the path to `/api/v2/users` is syntactically perfect, passes any schema, and still takes down all the traffic.
