# Remote access runbook — reaching your own window from a second machine

> The Russian text of this file: [REMOTE-ACCESS-RUNBOOK.ru.md](REMOTE-ACCESS-RUNBOOK.ru.md).
> Its product form is the **«Работать удалённо» / Work remotely** screen in the window
> (`spa/src/screens/remote-access`). This file is the source that screen is written from; when
> the two disagree, this file is wrong and gets fixed.

SMA lives on your machine. The daemon serves the window over plain http, behind a token, and
it binds `127.0.0.1` by default — meaning nothing outside that machine can reach it at all.
That default is a promise, not an oversight, and this runbook is about withdrawing it
deliberately rather than by accident.

## The one shape we support

**Both machines join one private network — an encrypted tunnel only they can see.** That is
the whole design. Any private network or encrypted tunnel qualifies; the requirement is
vendor-neutral and stated as a property, not as a product name:

> both machines can address each other at an address that does not exist on the internet.

Tailscale is the path we walked ourselves on a live machine (7 Aug 2026): installing it and
signing in takes minutes, the machine receives a name of the form `<machine>.<tailnet>.ts.net`
and an address in the CGNAT range, and **no daemon code has to change**. WireGuard, a
self-hosted mesh, or any VPN that gives both machines private addresses works the same way.

## What the product will not do, and why

**It does not install the network for you.** Running somebody else's installer out of ours
would bring another dependency, another licence and another trust boundary into your install,
silently. The screen explains and checks; you install.

**It does not help you forward a port to the internet.** The daemon speaks http, unencrypted.
A port exposed to the internet hands your token in clear text to anyone on the packet's path,
and what is behind that token is your queue, your keys and your machine. There is no flag, no
setting and no screen in this product that helps with it.

**It does not flip `bind` for you.** Changing `bind` away from `127.0.0.1` is a security
decision with consequences; it gets a visible warning and a human hand, never a quiet toggle.

## Four things the screen must say — and they are not decoration

Each is anchored by the key the screen and its test use, so the doc, the screen and the gate
cannot drift apart quietly.

### hostAwake — the host machine has to be on, and awake

The window is served by the daemon, and the daemon lives on the host machine. A closed laptop
lid is no window, whatever the network says. Decide what keeps the host awake before you plan
to depend on it.

### noAutostart — nothing comes back up by itself after a reboot

Neither the queue database nor the daemon: an ordinary install has no autostart. Until you
wire one by hand — `supervisor/setup-macos.md` (launchd) or `supervisor/setup-windows.md`
(Task Scheduler) — remote work is fragile for every user, not only for the founder: the first
reboot of the host puts the window out, and only the host can bring it back.

### tokenBecomesPassword — the token becomes a real password

While the daemon is reachable from its own machine only, the token is a convenience. The
second it is reachable from another machine, the token is the only thing between your queue
and anyone else on that network.

Rotate it **before** you open access:

```
node supervisor/daemon-control.mjs stop
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
# write the value into the "token" field of ~/.sma-daemon/config.json
node scripts/sma/cli.mjs open
```

The old link stops working the moment the daemon comes back up — that is the point. Never
send a link carrying the token through chat or mail.

### bindIsAGate — changing `bind` has consequences; it is not a toggle

Order matters, and it is the reverse of the tempting one:

1. bring the private network up on both machines;
2. rotate the token;
3. only then change `bind` in `~/.sma-daemon/config.json`, by hand;
4. restart the daemon and check the screen's facts again.

Prefer the **named private address** (`"bind": "100.x.y.z"`) over the `0.0.0.0` wildcard. The
wildcard opens every interface the machine has, including ones you were not thinking about;
the named address opens exactly the one you meant.

## What the screen checks, and how

The facts come from the daemon (`remoteAccess` on the existing `/api/state` payload — no new
route was added for this screen), and they are three:

- **the door** — `bind` and `port`, read from the daemon's own configuration;
- **who can see it** — `this_machine_only` (loopback), `named_address`, or `every_interface`
  (a wildcard bind);
- **the private network** — detected by address range, never by vendor: IPv4 CGNAT
  `100.64.0.0/10` and IPv6 unique-local `fc00::/7` are read as an encrypted private network;
  RFC1918 addresses are reported separately as `lan`, because an office wire is visible to
  everyone plugged into it and encrypts nothing.

From those the screen derives the address to type on the second machine, or explains its
absence. **The interesting case is a private network that is up while the daemon still listens
on the loopback**: the network is not the door, and the screen says exactly that instead of
printing an address that answers nothing.

An unreadable interface list is reported as "could not look", never as "there is none".

## Checking it worked

On the host: the screen's facts show the private address and an `openFrom` url. On the second
machine: open that url with the token, exactly as `node scripts/sma/cli.mjs open --print` puts
it together on the host. A bare address answers `401` by design.

If it does not open, the order of suspects is: the host is asleep (`hostAwake`); the daemon is
not running after a reboot (`noAutostart`); `bind` is still the loopback (`bindIsAGate`); the
two machines are not actually in the same private network.
