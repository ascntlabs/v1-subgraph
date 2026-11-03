#!/usr/bin/env python3
"""Acceptance checks for a synced ascnt-subgraph 2.0.0 deployment.

Read-only GraphQL queries against one endpoint, each compared with an oracle
computed here rather than with another subgraph field:

  meta       head block and no indexing errors
  hooks      the seven legacy hooks exist (deprecated + legacy), every pool on them
             is an Ascnt pool and links Pool.hook, factory hooks carry provenance,
             the hookless reference pool links nothing, ascntPoolCount agrees
  fees       ETH/MORPHO keeps feeTier 2999 with Uniswap's 499/499 protocol fee;
             Ascnt pools hold the 8388608 flag in feeTier and real rates in
             poolFee/lpFee; the latest swap's five rates are mutually consistent
  tvl        totalValueLockedToken0/1 against the reserves implied by the pool's
             own Tick rows (the walk the app runs as a stopgap); an empty pool is 0
  pricing    at the block of a pool's latest swap, each unlisted leg's derivedETH
             equals what findNativePerToken computes from that block's state, and
             matches the post-swap spot rather than the pre-swap one (no lag);
             Pool.lastSwapTimestamp tracks the latest swap
  hourfees   PoolHourData.lpFeesUSD = volumeUSD x lpFee x (1 - uni/1e6) / 1e6 and
             uniswapProtocolFeesUSD = volumeUSD x uni / 1e6 on static pools
  whitelist  newly whitelisted tokens are priced and carry volume; SPCXon is
             priced from its USDC pool
  modliq     ModifyLiquidity rows carry sqrtPrice/tick and one sign convention
  untracked  token day buckets' untrackedVolumeUSD is no longer a copy of volumeUSD
  positions  each Position's state equals what its own PositionSnapshot rows imply;
             no position without a modify

Usage:
  python3 scripts/acceptance.py --url https://api.studio.thegraph.com/query/120092/ascnt-mainnet/v2.0.0
  python3 scripts/acceptance.py --url <url> --pool 0x<poolId> --pool 0x<poolId>   # extra TVL/pricing pools
  python3 scripts/acceptance.py --url <url> --no-legacy                           # Robinhood

Exit status 1 when any check fails. Standard library only.
"""
import argparse
import json
import sys
import urllib.request
from decimal import Decimal, getcontext

getcontext().prec = 60
D = Decimal
Q96 = D(2) ** 96
MILLION = D(1_000_000)

ADDRESS_ZERO = '0x' + '0' * 40
POOL_MANAGER = '0x000000000004444c5dc75cb358380d2e3de08a90'
USDC_WETH_POOL = '0x4f88f7c99022eace4740c6898f59ce6a2e798a1e64ce54589720b7153eb224a7'  # bundle pool, hookless
ETH_MORPHO_POOL = '0xd9f5cbaeb88b7f0d9b0549257ddd4c46f984e2fc4bccf056cc254b9fe3417fff'  # static 2999, uni 499/499
PINNED = {  # derivedETH is a constant or 1/ethPriceUSD, never derived from a pool
    ADDRESS_ZERO,
    '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',  # WETH
    '0x6b175474e89094c44da98b954eedeac495271d0f',  # DAI
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',  # USDC
    '0xdac17f958d2ee523a2206206994597c13d831ec7',  # USDT
}
TOKENS = {
    'SPCXon': '0xc9eef266834730340a55b6cc24621b31baf55581',  # not whitelisted: priced via USDC pool
    'PAXG': '0x45804880de22913dafe09f4980848ece6ecbaf78',
    'XAUT': '0x68749665ff8d2d112fa859aa293f07a622782f38',
    'ZCHF': '0xb58e61c3098d85632df34eecfb899a1ed80921cb',
    'EURC': '0x1abaea1f7c830bd89acc67ec4af516284b1bc33c',
    'MORPHO': '0x58d97b57bb95320f9a05dc918aef65434969c2b2',
    'IEFon': '0xa2ec76139028f279a1c790d323c57cc4158098d6',
    'IEIon': '0xe905c437a30ae6d8c0576e0d9f6360b93b94976d',
}
LEGACY_HOOKS = {
    '0x2d2523c292359e7dea2617214cb5ae62c79fb0c0',
    '0xde1949891ca439164a6850b98b4aed9cdcf0e0c0',
    '0x738042b4dc94b81c4eb14051d54180194963e0c0',
    '0xce361858db5737492f6d7240caa4ba786da8f0c0',
    '0x86817f6d05e0991beb04686a26963a38461b70c0',
    '0x29d6e0ff868ba37fd81f84208b1bc6781dffb0c0',
    '0x38fdc1b79148abe3c621467e3cc6556453b0f6c0',
}
DYNAMIC_FEE_FLAG = 8388608
FRESH_SECONDS = 86400
FLOOR_USD = D(1000)
PAGE = 1000

POOL_FIELDS = """
  id hooks hook { id legacy deprecated } isAscntPool isDynamicFee txCount
  feeTier poolFee lpFee ascntProtocolFee totalSwapFee
  uniswapProtocolFeeZeroForOne uniswapProtocolFeeOneForZero
  tick liquidity sqrtPrice lastSwapTimestamp
  totalValueLockedToken0 totalValueLockedToken1 totalValueLockedUSD
  token0 { id symbol decimals derivedETH } token1 { id symbol decimals derivedETH }
"""
PRICING_POOL_FIELDS = """
  id liquidity lastSwapTimestamp token0Price token1Price
  totalValueLockedToken0 totalValueLockedToken1
  token0 { id derivedETH } token1 { id derivedETH }
"""


# ------------------------------------------------------------------ plumbing --
class Gql:
    def __init__(self, url):
        self.url = url

    def __call__(self, query, variables=None):
        body = json.dumps({'query': query, 'variables': variables or {}}).encode()
        req = urllib.request.Request(self.url, data=body, headers={'content-type': 'application/json'})
        with urllib.request.urlopen(req, timeout=90) as r:
            payload = json.loads(r.read())
        if payload.get('errors'):
            raise RuntimeError(json.dumps(payload['errors'])[:300])
        return payload['data']


class Report:
    def __init__(self):
        self.counts = {'PASS': 0, 'FAIL': 0, 'WARN': 0, 'SKIP': 0}

    def _add(self, status, check, detail):
        self.counts[status] += 1
        print(f'{status:4}  {check:<48} {detail}')

    def ok(self, check, detail=''):
        self._add('PASS', check, detail)

    def fail(self, check, detail=''):
        self._add('FAIL', check, detail)

    def warn(self, check, detail=''):
        self._add('WARN', check, detail)

    def skip(self, check, detail=''):
        self._add('SKIP', check, detail)

    def close(self):
        c = self.counts
        print(f"\n{c['PASS']} passed, {c['FAIL']} failed, {c['WARN']} warnings, {c['SKIP']} skipped")
        return 1 if c['FAIL'] else 0


def rel(a, b):
    """Relative difference of two Decimals against the larger magnitude; 0 when both are 0."""
    m = max(abs(a), abs(b))
    return D(0) if m == 0 else abs(a - b) / m


def pct(x):
    return f'{float(x) * 100:.4f}%'


def name_of(pool):
    return f"{pool['token0']['symbol']}/{pool['token1']['symbol']} {pool['id'][:10]}"


def spot_token1_per_token0(sqrt_price_x96, dec0, dec1):
    """Marginal price in human units from sqrtPriceX96 (same scaling as sqrtPriceX96ToTokenPrices)."""
    s = D(int(sqrt_price_x96)) / Q96
    return s * s * D(10) ** dec0 / D(10) ** dec1


def sqrt_ratio(tick):
    return D('1.0001') ** (D(tick) / 2)


def walk_reserves(ticks, current_tick, sqrt_price_x96, dec0, dec1):
    """Reserves implied by initialized ticks.

    Liquidity between consecutive ticks is the running sum of liquidityNet from the
    lowest tick up. A range below the price holds only token1, one above only
    token0, the one containing it holds both, split at the pool's sqrtPrice.
    Returns (amount0, amount1, active liquidity in the current range).
    """
    rows = sorted((int(t['tickIdx']), int(t['liquidityNet'])) for t in ticks)
    sqrt_cur = D(int(sqrt_price_x96)) / Q96
    raw0 = raw1 = D(0)
    liquidity = 0
    active = 0
    for i in range(len(rows) - 1):
        liquidity += rows[i][1]
        lower, upper = rows[i][0], rows[i + 1][0]
        if liquidity <= 0:
            continue
        sl, su = sqrt_ratio(lower), sqrt_ratio(upper)
        if current_tick < lower:
            raw0 += liquidity * (1 / sl - 1 / su)
        elif current_tick >= upper:
            raw1 += liquidity * (su - sl)
        else:
            raw0 += liquidity * (1 / sqrt_cur - 1 / su)
            raw1 += liquidity * (sqrt_cur - sl)
            active = liquidity
    return raw0 / D(10) ** dec0, raw1 / D(10) ** dec1, active


def fetch_ticks(g, pool_id):
    out, last = [], -887273
    while True:
        rows = g(
            'query($p:String!,$t:BigInt!){ticks(first:1000,orderBy:tickIdx,orderDirection:asc,'
            'where:{pool:$p,tickIdx_gt:$t}){tickIdx liquidityNet liquidityGross}}',
            {'p': pool_id, 't': str(last)},
        )['ticks']
        out += [r for r in rows if int(r['liquidityGross']) > 0]
        if len(rows) < PAGE:
            return out
        last = int(rows[-1]['tickIdx'])


def fetch_pool(g, pool_id, block=None):
    arg = f', block: {{number: {block}}}' if block else ''
    return g(f'query($p:ID!){{pool(id:$p{arg}){{{POOL_FIELDS}}}}}', {'p': pool_id})['pool']


def fetch_all_pools(g, where):
    out, last = [], ''
    while True:
        rows = g(
            f'query($l:ID!){{pools(first:1000,orderBy:id,where:{{id_gt:$l,{where}}}){{{POOL_FIELDS}}}}}',
            {'l': last},
        )['pools']
        out += rows
        if len(rows) < PAGE:
            return out
        last = rows[-1]['id']


# ------------------------------------------------------------------- checks --
def check_meta(g, rep):
    try:
        m = g('{_meta{block{number timestamp}hasIndexingErrors deployment}}')['_meta']
    except RuntimeError:
        m = g('{_meta{block{number}hasIndexingErrors deployment}}')['_meta']
    head = int(m['block']['number'])
    print(f"deployment {m['deployment']} at block {head}")
    if m['hasIndexingErrors']:
        rep.fail('meta: indexing errors', 'hasIndexingErrors is true')
    else:
        rep.ok('meta: no indexing errors', f'head {head}')
    ts = m['block'].get('timestamp')
    if ts is None:
        ts = int(g('{swaps(first:1,orderBy:timestamp,orderDirection:desc){timestamp}}')['swaps'][0]['timestamp'])
    return head, int(ts)


def check_hooks(g, rep):
    hooks = g('{hooks(first:200){id legacy deprecated factory salt isSubscriber createdAtBlockNumber}}')['hooks']
    legacy = {h['id'] for h in hooks if h['legacy']}
    if legacy == LEGACY_HOOKS:
        rep.ok('hooks: seven legacy hooks present')
    else:
        rep.fail('hooks: legacy set', f'missing {sorted(LEGACY_HOOKS - legacy)} extra {sorted(legacy - LEGACY_HOOKS)}')
    for h in hooks:
        if h['legacy']:
            if not h['deprecated']:
                rep.fail(f"hooks: {h['id'][:10]} legacy but not deprecated")
            if h['factory'] != ADDRESS_ZERO:
                rep.fail(f"hooks: {h['id'][:10]} legacy with a factory", h['factory'])
        else:
            if h['factory'] == ADDRESS_ZERO or h['salt'] in ('0x', ''):
                rep.warn(f"hooks: {h['id'][:10]} factory hook without provenance", 'seen without HookDeployed')
    for hook_id in sorted(legacy):
        on_addr = fetch_all_pools(g, f'hooks:"{hook_id}"')
        linked = [p for p in on_addr if p['hook'] and p['hook']['id'] == hook_id]
        flagged = [p for p in on_addr if p['isAscntPool']]
        if not on_addr:
            rep.warn(f'hooks: {hook_id[:10]} has no pools')
        elif len(linked) == len(on_addr) and len(flagged) == len(on_addr):
            rep.ok(f'hooks: {hook_id[:10]} pools linked + flagged', f'{len(on_addr)} pools')
        else:
            rep.fail(f'hooks: {hook_id[:10]} pools', f'{len(on_addr)} on address, {len(linked)} linked, {len(flagged)} flagged')
    ref = fetch_pool(g, USDC_WETH_POOL)
    if ref is None:
        rep.skip('hooks: hookless reference pool', 'USDC/WETH pool not found')
    elif ref['hooks'] == ADDRESS_ZERO and ref['hook'] is None:
        rep.ok('hooks: hookless pool has no Pool.hook')
    else:
        rep.fail('hooks: hookless pool', f"hooks {ref['hooks']} hook {ref['hook']}")
    ascnt = fetch_all_pools(g, 'isAscntPool:true')
    pm = g('query($i:ID!){poolManager(id:$i){ascntPoolCount ascntPools{id}}}', {'i': POOL_MANAGER})['poolManager']
    if pm is None:
        rep.skip('hooks: ascntPoolCount', 'PoolManager entity not found (wrong network?)')
    elif int(pm['ascntPoolCount']) == len(ascnt) == len(pm['ascntPools']):
        rep.ok('hooks: ascntPoolCount agrees', f'{len(ascnt)} Ascnt pools')
    else:
        rep.fail('hooks: ascntPoolCount', f"count {pm['ascntPoolCount']}, list {len(pm['ascntPools'])}, flagged {len(ascnt)}")
    return ascnt


def check_fees(g, rep, ascnt_pools):
    m = fetch_pool(g, ETH_MORPHO_POOL)
    if m is None:
        rep.skip('fees: ETH/MORPHO', 'pool not found')
    else:
        want = {'feeTier': '2999', 'poolFee': '2999', 'lpFee': '2999', 'ascntProtocolFee': '0',
                'uniswapProtocolFeeZeroForOne': '499', 'uniswapProtocolFeeOneForZero': '499'}
        bad = {k: m[k] for k, v in want.items() if m[k] != v}
        if bad or m['isDynamicFee']:
            rep.fail('fees: ETH/MORPHO rates', f'{bad} isDynamicFee={m["isDynamicFee"]}')
        else:
            rep.ok('fees: ETH/MORPHO rates', f"totalSwapFee {m['totalSwapFee']}")
    for p in ascnt_pools:
        n = name_of(p)
        if p['hook'] and p['hook']['legacy'] and not p['isDynamicFee']:
            continue  # a static-fee legacy pool has nothing dynamic to check
        if not p['isDynamicFee'] or p['feeTier'] != str(DYNAMIC_FEE_FLAG):
            rep.fail(f'fees: {n} feeTier flag', f"feeTier {p['feeTier']} isDynamicFee {p['isDynamicFee']}")
            continue
        pool_fee, lp, asc = int(p['poolFee']), int(p['lpFee']), int(p['ascntProtocolFee'])
        if p['lastSwapTimestamp'] is None:
            if (pool_fee, lp, asc) == (0, 0, 0):
                rep.ok(f'fees: {n} unswapped rates 0')
            else:
                rep.fail(f'fees: {n} unswapped rates', f'{pool_fee}/{lp}/{asc}')
            continue
        if pool_fee <= 0 or lp <= 0 or pool_fee >= DYNAMIC_FEE_FLAG or asc != pool_fee - lp or asc < 0:
            rep.fail(f'fees: {n} pool rates', f'poolFee {pool_fee} lpFee {lp} ascnt {asc}')
        else:
            rep.ok(f'fees: {n} pool rates', f'poolFee {pool_fee} lpFee {lp} ascnt {asc}')
        s = latest_swap(g, p['id'])
        if s is None:
            continue
        sp, sl, sa, su, st = (int(s[k]) for k in ('poolFee', 'lpFee', 'ascntProtocolFee', 'uniswapProtocolFee', 'totalSwapFee'))
        unis = {int(p['uniswapProtocolFeeZeroForOne']), int(p['uniswapProtocolFeeOneForZero'])}
        problems = []
        if sa != sp - sl:
            problems.append(f'ascnt {sa} != poolFee {sp} - lpFee {sl}')
        if s['dynamicFeePips'] is not None and int(s['dynamicFeePips']) != sp:
            problems.append(f"poolFee {sp} != dynamicFeePips {s['dynamicFeePips']}")
        if su not in unis:
            problems.append(f'uni {su} not in {sorted(unis)}')
        if st != sp + su:
            problems.append(f'totalSwapFee {st} != poolFee {sp} + uni {su}')
        if problems:
            rep.fail(f'fees: {n} latest swap rates', '; '.join(problems))
        else:
            rep.ok(f'fees: {n} latest swap rates', f'{sp}/{sl}/{sa}/{su}/{st}')


def latest_swap(g, pool_id):
    rows = g(
        'query($p:String!){swaps(first:2,orderBy:timestamp,orderDirection:desc,where:{pool:$p}){'
        'id timestamp transaction{blockNumber} sqrtPriceX96 sqrtPriceX96Before poolFee lpFee ascntProtocolFee '
        'uniswapProtocolFee totalSwapFee dynamicFeePips}}',
        {'p': pool_id},
    )['swaps']
    if not rows:
        return None
    s = rows[0]
    if s['sqrtPriceX96Before'] is None and len(rows) > 1:
        s['sqrtPriceX96Before'] = rows[1]['sqrtPriceX96']  # previous swap's post-swap price
    return s


def check_tvl(g, rep, pool, tol):
    n = name_of(pool)
    dec0, dec1 = int(pool['token0']['decimals']), int(pool['token1']['decimals'])
    ticks = fetch_ticks(g, pool['id'])
    stored0, stored1 = D(pool['totalValueLockedToken0']), D(pool['totalValueLockedToken1'])
    if len(ticks) < 2:
        if int(pool['liquidity']) == 0 and stored0 < D('1e-9') and stored1 < D('1e-9'):
            rep.ok(f'tvl: {n} empty pool reads 0')
        elif int(pool['liquidity']) == 0:
            rep.fail(f'tvl: {n} empty pool', f'no ticks, liquidity 0, stored {stored0} / {stored1}')
        else:
            rep.skip(f'tvl: {n}', f'{len(ticks)} ticks, liquidity {pool["liquidity"]}')
        return
    a0, a1, active = walk_reserves(ticks, int(pool['tick']), pool['sqrtPrice'], dec0, dec1)
    if active != int(pool['liquidity']):
        rep.warn(f'tvl: {n} tick liquidity', f"walk {active} vs pool.liquidity {pool['liquidity']}")
    r0, r1 = rel(a0, stored0), rel(a1, stored1)
    detail = f'walk {a0:.6f} / {a1:.6f}  stored {stored0:.6f} / {stored1:.6f}  diff {pct(r0)} / {pct(r1)}'
    # a leg that is tiny in absolute terms (dust) is compared loosely
    big0, big1 = a0 * D(10) ** dec0 > 1000, a1 * D(10) ** dec1 > 1000
    if (r0 <= tol or not big0) and (r1 <= tol or not big1):
        rep.ok(f'tvl: {n}', detail)
    else:
        rep.fail(f'tvl: {n}', detail)


def expected_derived_eth(token, eth_usd, now_ts):
    """findNativePerToken as the mapping computes it, over the token's whitelistPools."""
    largest = fresh = (D(0), D(0))
    for p in token['whitelistPools']:
        if int(p['liquidity']) <= 0:
            continue
        if p['token0']['id'] == token['id']:
            other, leg, price = p['token1'], D(p['totalValueLockedToken1']), D(p['token1Price'])
        elif p['token1']['id'] == token['id']:
            other, leg, price = p['token0'], D(p['totalValueLockedToken0']), D(p['token0Price'])
        else:
            continue
        leg_eth = leg * D(other['derivedETH'])
        price_eth = price * D(other['derivedETH'])
        if leg_eth * eth_usd * 2 <= FLOOR_USD:
            continue
        if leg_eth > largest[0]:
            largest = (leg_eth, price_eth)
        ls = p['lastSwapTimestamp']
        if ls is not None and now_ts - int(ls) <= FRESH_SECONDS and leg_eth > fresh[0]:
            fresh = (leg_eth, price_eth)
    return fresh[1] if fresh[0] > 0 else largest[1]


def check_pricing(g, rep, pool, tol):
    n = name_of(pool)
    s = latest_swap(g, pool['id'])
    if s is None:
        rep.skip(f'pricing: {n}', 'no swaps')
        return
    if pool['lastSwapTimestamp'] is None or int(pool['lastSwapTimestamp']) < int(s['timestamp']):
        rep.fail(f'pricing: {n} lastSwapTimestamp', f"{pool['lastSwapTimestamp']} vs latest swap {s['timestamp']}")
    else:
        rep.ok(f'pricing: {n} lastSwapTimestamp', s['timestamp'])
    blk = int(s['transaction']['blockNumber'])
    try:
        at = g(
            'query($p:ID!,$b:Int!,$t0:ID!,$t1:ID!){'
            f'pool(id:$p,block:{{number:$b}}){{sqrtPrice token0{{id derivedETH}} token1{{id derivedETH}}}}'
            f'bundle(id:"1",block:{{number:$b}}){{ethPriceUSD}}'
            f'a:token(id:$t0,block:{{number:$b}}){{id derivedETH whitelistPools{{{PRICING_POOL_FIELDS}}}}}'
            f'b:token(id:$t1,block:{{number:$b}}){{id derivedETH whitelistPools{{{PRICING_POOL_FIELDS}}}}}'
            '}',
            {'p': pool['id'], 'b': blk, 't0': pool['token0']['id'], 't1': pool['token1']['id']},
        )
    except RuntimeError as e:
        rep.skip(f'pricing: {n} at block {blk}', f'time-travel query failed: {e}')
        return
    eth_usd = D(at['bundle']['ethPriceUSD'])
    block_ts = int(g('query($b:Int!){_meta(block:{number:$b}){block{timestamp}}}', {'b': blk})['_meta']['block']['timestamp']) \
        if _has_block_timestamp(g) else int(s['timestamp'])
    dec0, dec1 = int(pool['token0']['decimals']), int(pool['token1']['decimals'])
    spot_after = spot_token1_per_token0(at['pool']['sqrtPrice'], dec0, dec1)
    spot_before = spot_token1_per_token0(s['sqrtPriceX96Before'], dec0, dec1) if s['sqrtPriceX96Before'] else None
    for leg, other, flip in (('a', 'b', False), ('b', 'a', True)):
        tok = at[leg]
        if tok['id'] in PINNED:
            continue
        stored = D(tok['derivedETH'])
        expected = expected_derived_eth(tok, eth_usd, block_ts)
        sym = pool['token1']['symbol'] if flip else pool['token0']['symbol']
        if expected == 0:
            rep.warn(f'pricing: {sym} at block {blk}', f'no whitelist pool clears the floor; stored {stored}')
            continue
        r = rel(stored, expected)
        # price of this leg in units of the other leg, implied by derivedETH on both sides
        other_eth = D(at[other]['derivedETH'])
        implied = stored / other_eth if other_eth > 0 else None
        spot_leg = (1 / spot_after) if flip else spot_after
        pre_leg = ((1 / spot_before) if flip else spot_before) if spot_before else None
        lag = ''
        if implied is not None and pre_leg is not None and rel(implied, spot_leg) > tol and rel(implied, pre_leg) <= tol:
            lag = '  LAG: matches the pre-swap spot'
        detail = f'stored {stored:.10f} expected {expected:.10f} diff {pct(r)}' \
                 + (f'; vs own spot {pct(rel(implied, spot_leg))}' if implied is not None else '') + lag
        if r <= tol and not lag:
            rep.ok(f'pricing: {sym} at block {blk}', detail)
        else:
            rep.fail(f'pricing: {sym} at block {blk}', detail)


_BLOCK_TS = {}


def _has_block_timestamp(g):
    if 'v' not in _BLOCK_TS:
        try:
            g('{_meta{block{timestamp}}}')
            _BLOCK_TS['v'] = True
        except RuntimeError:
            _BLOCK_TS['v'] = False
    return _BLOCK_TS['v']


def check_hour_fees(g, rep, pool, tol):
    n = name_of(pool)
    rows = g(
        'query($p:String!){poolHourDatas(first:6,orderBy:periodStartUnix,orderDirection:desc,'
        'where:{pool:$p,volumeUSD_gt:"0"}){periodStartUnix volumeUSD lpFeesUSD uniswapProtocolFeesUSD}}',
        {'p': pool['id']},
    )['poolHourDatas']
    if not rows:
        rep.skip(f'hourfees: {n}', 'no hour buckets with volume')
        return
    lp = D(pool['lpFee'])
    u_lo = D(min(int(pool['uniswapProtocolFeeZeroForOne']), int(pool['uniswapProtocolFeeOneForZero'])))
    u_hi = D(max(int(pool['uniswapProtocolFeeZeroForOne']), int(pool['uniswapProtocolFeeOneForZero'])))
    bad = []
    for r in rows:
        vol, lp_usd, uni_usd = D(r['volumeUSD']), D(r['lpFeesUSD']), D(r['uniswapProtocolFeesUSD'])
        lp_lo = vol * lp * (MILLION - u_hi) / MILLION / MILLION
        lp_hi = vol * lp * (MILLION - u_lo) / MILLION / MILLION
        if not (lp_lo * (1 - tol) <= lp_usd <= lp_hi * (1 + tol)):
            bad.append(f"{r['periodStartUnix']}: lp {lp_usd:.4f} outside [{lp_lo:.4f}, {lp_hi:.4f}]")
        if not (vol * u_lo / MILLION * (1 - tol) <= uni_usd <= vol * u_hi / MILLION * (1 + tol)):
            bad.append(f"{r['periodStartUnix']}: uni {uni_usd:.4f} outside [{vol * u_lo / MILLION:.4f}, {vol * u_hi / MILLION:.4f}]")
    if bad:
        rep.fail(f'hourfees: {n}', '; '.join(bad[:3]))
    else:
        rep.ok(f'hourfees: {n}', f'{len(rows)} buckets, lpFee {lp} uni {u_lo}-{u_hi}')


def check_whitelist(g, rep):
    for sym, addr in TOKENS.items():
        t = g('query($i:ID!){token(id:$i){symbol derivedETH volumeUSD untrackedVolumeUSD txCount whitelistPools{id}}}', {'i': addr})['token']
        if t is None:
            rep.warn(f'whitelist: {sym}', 'no Token entity (no v4 pool yet)')
            continue
        detail = f"derivedETH {D(t['derivedETH']):.8f} volumeUSD {D(t['volumeUSD']):.2f} whitelistPools {len(t['whitelistPools'])} tx {t['txCount']}"
        if D(t['derivedETH']) > 0:
            rep.ok(f'whitelist: {sym} priced', detail)
        elif t['whitelistPools']:
            rep.warn(f'whitelist: {sym} unpriced', detail + ' (no pool clears the floor)')
        else:
            rep.warn(f'whitelist: {sym} no whitelist pools', detail)


def check_modliq(g, rep):
    rows = g('{modifyLiquidities(first:20,orderBy:timestamp,orderDirection:desc){id amount amount0 amount1 amountUSD sqrtPrice tick}}')['modifyLiquidities']
    if not rows:
        rep.skip('modliq', 'no rows')
        return
    bad = []
    for r in rows:
        amt, a0, a1, usd = int(r['amount']), D(r['amount0']), D(r['amount1']), D(r['amountUSD'])
        if int(r['sqrtPrice']) <= 0:
            bad.append(f"{r['id']}: sqrtPrice {r['sqrtPrice']}")
        sign = (amt > 0) - (amt < 0)
        for label, v in (('amount0', a0), ('amount1', a1), ('amountUSD', usd)):
            if v != 0 and ((v > 0) - (v < 0)) != sign:
                bad.append(f"{r['id']}: {label} {v} against amount {amt}")
    if bad:
        rep.fail('modliq: snapshot + signs', '; '.join(bad[:3]))
    else:
        rep.ok('modliq: snapshot + signs', f'{len(rows)} latest rows')


def check_untracked(g, rep):
    rows = g(
        'query($t:String!){tokenDayDatas(first:60,orderBy:date,orderDirection:desc,where:{token:$t,volumeUSD_gt:"0"}){date volumeUSD untrackedVolumeUSD}}',
        {'t': TOKENS['SPCXon']},
    )['tokenDayDatas']
    if not rows:
        rep.skip('untracked: SPCXon day buckets', 'no buckets with volume')
    elif all(D(r['volumeUSD']) == D(r['untrackedVolumeUSD']) for r in rows):
        rep.fail('untracked: SPCXon day buckets', f'{len(rows)} buckets, untracked always equals tracked')
    else:
        rep.ok('untracked: SPCXon day buckets', f'{len(rows)} buckets, figures differ')


POSITION_FIELDS = """
  id pool { id } tickLower tickUpper mintSqrtPrice liquidity modifyCount
  depositedToken0 depositedToken1 withdrawnToken0 withdrawnToken1
  depositedUSD withdrawnUSD depositedETH withdrawnETH closedAtTimestamp
  snapshots(first:1000){ id liquidityDelta liquidity amount0 amount1 amountUSD amountETH sqrtPrice
    depositedToken0 depositedToken1 withdrawnToken0 withdrawnToken1 depositedUSD withdrawnUSD depositedETH withdrawnETH }
  modifyLiquiditys(first:1000){ id }
"""
ACCUMULATORS = ('depositedToken0', 'depositedToken1', 'withdrawnToken0', 'withdrawnToken1',
                'depositedUSD', 'withdrawnUSD', 'depositedETH', 'withdrawnETH')


def near(a, b):
    # the subgraph accumulates step by step at BigDecimal precision; the re-sum here is exact
    return abs(a - b) <= max(abs(a), abs(b)) * D('1e-12') + D('1e-18')


def check_positions(g, rep):
    rows = g('query{positions(first:100,orderBy:lastModifiedTimestamp,orderDirection:desc,'
             'where:{modifyCount_gt:"0"}){' + POSITION_FIELDS + '}}')['positions']
    if not rows:
        rep.skip('positions: state vs snapshots', 'no position with a modify')
    else:
        bad = []
        for p in rows:
            n = int(p['modifyCount'])
            snaps = sorted(p['snapshots'], key=lambda x: int(x['id'].split('#')[1]))
            if p['pool'] is None or p['tickLower'] is None or int(p['mintSqrtPrice'] or 0) <= 0:
                bad.append(f"{p['id']}: pool / range / entry price missing")
                continue
            if len(snaps) != n or len(p['modifyLiquiditys']) != n:
                bad.append(f"{p['id']}: modifyCount {n}, {len(snaps)} snapshots, {len(p['modifyLiquiditys'])} modifies")
                continue
            last = snaps[-1]
            if last['id'] != f"{p['id']}#{n}" or int(last['liquidity']) != int(p['liquidity']):
                bad.append(f"{p['id']}: last snapshot {last['id']} liquidity {last['liquidity']} vs {p['liquidity']}")
            if sum(int(x['liquidityDelta']) for x in snaps) != int(p['liquidity']):
                bad.append(f"{p['id']}: liquidity {p['liquidity']} is not the sum of the deltas")
            if any(D(last[k]) != D(p[k]) for k in ACCUMULATORS):
                bad.append(f"{p['id']}: last snapshot accumulators differ from the position")
            adds = [x for x in snaps if int(x['liquidityDelta']) > 0]
            removes = [x for x in snaps if int(x['liquidityDelta']) < 0]
            resum = {
                'depositedToken0': sum((D(x['amount0']) for x in adds), D(0)),
                'depositedToken1': sum((D(x['amount1']) for x in adds), D(0)),
                'depositedUSD': sum((D(x['amountUSD']) for x in adds), D(0)),
                'depositedETH': sum((D(x['amountETH']) for x in adds), D(0)),
                'withdrawnToken0': -sum((D(x['amount0']) for x in removes), D(0)),
                'withdrawnToken1': -sum((D(x['amount1']) for x in removes), D(0)),
                'withdrawnUSD': -sum((D(x['amountUSD']) for x in removes), D(0)),
                'withdrawnETH': -sum((D(x['amountETH']) for x in removes), D(0)),
            }
            for k, want in resum.items():
                if not near(D(p[k]), want):
                    bad.append(f"{p['id']}: {k} {p[k]} vs re-sum {want}")
            if any(int(x['sqrtPrice']) <= 0 for x in snaps):
                bad.append(f"{p['id']}: snapshot without a price")
            if (p['closedAtTimestamp'] is not None) == (int(p['liquidity']) > 0):
                bad.append(f"{p['id']}: closedAtTimestamp {p['closedAtTimestamp']} with liquidity {p['liquidity']}")
        if bad:
            rep.fail('positions: state vs snapshots', '; '.join(bad[:3]))
        else:
            rep.ok('positions: state vs snapshots', f'{len(rows)} most recently modified positions agree')

    # a mint's NFT transfer and its ModifyLiquidity share a transaction, so a position
    # left without a modify points at a handler gap (or the head block mid-transaction)
    orphans = g('{positions(first:5,where:{modifyCount:"0"}){id}}')['positions']
    if orphans:
        rep.warn('positions: without a modify', ', '.join(o['id'] for o in orphans))
    else:
        rep.ok('positions: without a modify', 'none')


# --------------------------------------------------------------------- main --
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--url', required=True, help='GraphQL endpoint (Studio version URL or gateway deployments/id URL)')
    ap.add_argument('--pool', action='append', default=[], help='extra pool id for the tvl/pricing/hourfees checks')
    ap.add_argument('--top', type=int, default=5, help='Ascnt pools by TVL to check (default 5)')
    ap.add_argument('--tvl-tol', type=float, default=0.01, help='relative TVL tolerance per leg (default 1%%)')
    ap.add_argument('--price-tol', type=float, default=0.001, help='relative pricing tolerance (default 0.1%%)')
    ap.add_argument('--fee-tol', type=float, default=0.005, help='relative hour-bucket fee tolerance (default 0.5%%)')
    ap.add_argument('--no-legacy', action='store_true', help='skip the legacy hook set (chains without them)')
    args = ap.parse_args()

    g, rep = Gql(args.url), Report()
    check_meta(g, rep)
    ascnt = check_hooks(g, rep) if not args.no_legacy else fetch_all_pools(g, 'isAscntPool:true')
    check_fees(g, rep, ascnt)

    static = [p for p in (fetch_pool(g, USDC_WETH_POOL), fetch_pool(g, ETH_MORPHO_POOL)) if p]
    live = sorted((p for p in ascnt if int(p['liquidity']) > 0), key=lambda p: D(p['totalValueLockedUSD']), reverse=True)
    extra = [p for p in (fetch_pool(g, i.lower()) for i in args.pool) if p]
    seen, targets = set(), []
    for p in static + live[: args.top] + extra:
        if p['id'] not in seen:
            seen.add(p['id'])
            targets.append(p)

    for p in targets:
        check_tvl(g, rep, p, D(str(args.tvl_tol)))
    for p in targets:
        check_pricing(g, rep, p, D(str(args.price_tol)))
    for p in static + [p for p in extra if not p['isDynamicFee']]:
        check_hour_fees(g, rep, p, D(str(args.fee_tol)))
    check_whitelist(g, rep)
    check_modliq(g, rep)
    check_untracked(g, rep)
    check_positions(g, rep)
    sys.exit(rep.close())


if __name__ == '__main__':
    main()
