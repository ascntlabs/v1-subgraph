#!/usr/bin/env python3
"""Replay one Uniswap v4 pool's PoolManager events and compare three TVL figures.

  upstream  what the current subgraph accumulates: gross swap input - output,
            plus ModifyLiquidity amounts (same math as src/utils/liquidityMath)
  fixed     swap input net of Swap.fee - output, plus ModifyLiquidity amounts
            (what fix/protocol-fee-and-tvl-drift accumulates)
  true      integrate the net liquidity of every position range at the last
            sqrtPrice (what the bug report computed from Tick rows)

If the fee leak is the whole story, `upstream - fixed` equals the summed fees and
`fixed` sits a hair above `true` (per-step rounding dust). Anything else means a
second leak.

Usage:
  python3 scripts/verify-pool-tvl.py <poolId> [--rpc URL] [--pool-manager ADDR] [--from BLOCK]

Defaults: mainnet PoolManager, start block 21688329, rpc https://ethereum-rpc.publicnode.com
No dependencies beyond the standard library (keccak is inlined).
"""
import argparse
import json
import sys
import time
import urllib.request
from fractions import Fraction

# ---------------------------------------------------------------- keccak-256 --
_RC = [
    0x0000000000000001, 0x0000000000008082, 0x800000000000808A, 0x8000000080008000,
    0x000000000000808B, 0x0000000080000001, 0x8000000080008081, 0x8000000000008009,
    0x000000000000008A, 0x0000000000000088, 0x0000000080008009, 0x000000008000000A,
    0x000000008000808B, 0x800000000000008B, 0x8000000000008089, 0x8000000000008003,
    0x8000000000008002, 0x8000000000000080, 0x000000000000800A, 0x800000008000000A,
    0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008,
]
_ROTC = [1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44]
_PILN = [10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1]
_M64 = (1 << 64) - 1


def _rol(x, n):
    return ((x << n) | (x >> (64 - n))) & _M64


def _keccak_f(st):
    for rnd in range(24):
        bc = [st[i] ^ st[i + 5] ^ st[i + 10] ^ st[i + 15] ^ st[i + 20] for i in range(5)]
        for i in range(5):
            t = bc[(i + 4) % 5] ^ _rol(bc[(i + 1) % 5], 1)
            for j in range(0, 25, 5):
                st[j + i] ^= t
        t = st[1]
        for i in range(24):
            j = _PILN[i]
            t, st[j] = st[j], _rol(t, _ROTC[i])
        for j in range(0, 25, 5):
            bc = st[j:j + 5]
            for i in range(5):
                st[j + i] ^= (~bc[(i + 1) % 5]) & bc[(i + 2) % 5]
        st[0] ^= _RC[rnd]


def keccak256(data: bytes) -> bytes:
    rate = 136
    st = [0] * 25
    buf = bytearray(data) + b"\x01"
    buf += b"\x00" * (-len(buf) % rate)
    buf[-1] |= 0x80
    for off in range(0, len(buf), rate):
        for i in range(rate // 8):
            st[i] ^= int.from_bytes(buf[off + 8 * i:off + 8 * i + 8], "little")
        _keccak_f(st)
    return b"".join(st[i].to_bytes(8, "little") for i in range(4))


assert keccak256(b"").hex() == "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470", "keccak self-test failed"


def topic(sig: str) -> str:
    return "0x" + keccak256(sig.encode()).hex()


TOPIC_INIT = topic("Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)")
TOPIC_MODIFY = topic("ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)")
TOPIC_SWAP = topic("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)")
TOPIC_PROTOCOL_FEE = topic("ProtocolFeeUpdated(bytes32,uint24)")

# ------------------------------------------------------------- v4 math ports --
Q96 = 1 << 96
MAX_U256 = (1 << 256) - 1
_TICK_CONSTS = [
    (0x2, 0xfff97272373d413259a46990580e213a), (0x4, 0xfff2e50f5f656932ef12357cf3c7fdcc),
    (0x8, 0xffe5caca7e10e4e61c3624eaa0941cd0), (0x10, 0xffcb9843d60f6159c9db58835c926644),
    (0x20, 0xff973b41fa98c081472e6896dfb254c0), (0x40, 0xff2ea16466c96a3843ec78b326b52861),
    (0x80, 0xfe5dee046a99a2a811c461f1969c3053), (0x100, 0xfcbe86c7900a88aedcffc83b479aa3a4),
    (0x200, 0xf987a7253ac413176f2b074cf7815e54), (0x400, 0xf3392b0822b70005940c7a398e4b70f3),
    (0x800, 0xe7159475a2c29b7443b29c7fa6e889d9), (0x1000, 0xd097f3bdfd2022b8845ad8f792aa5825),
    (0x2000, 0xa9f746462d870fdf8a65dc1f90e061e5), (0x4000, 0x70d869a156d2a1b890bb3df62baf32f7),
    (0x8000, 0x31be135f97d08fd981231505542fcfa6), (0x10000, 0x9aa508b5b7a84e1c677de54f3e99bc9),
    (0x20000, 0x5d6af8dedb81196699c329225ee604), (0x40000, 0x2216e584f5fa1ea926041bedfe98),
    (0x80000, 0x48a170391f7dc42444e8fa2),
]
_sqrt_cache = {}


def sqrt_ratio_at_tick(tick: int) -> int:
    if tick in _sqrt_cache:
        return _sqrt_cache[tick]
    a = abs(tick)
    ratio = 0xfffcb933bd6fad37aa2d162d1a594001 if a & 1 else 1 << 128
    for mask, c in _TICK_CONSTS:
        if a & mask:
            ratio = (ratio * c) >> 128
    if tick > 0:
        ratio = MAX_U256 // ratio
    r = (ratio >> 32) + (1 if ratio & 0xffffffff else 0)
    _sqrt_cache[tick] = r
    return r


def _ceil_div(a, b):
    return -(-a // b)


def amount0_delta(sqrt_a, sqrt_b, liq, round_up):
    if sqrt_a > sqrt_b:
        sqrt_a, sqrt_b = sqrt_b, sqrt_a
    n1, n2 = liq << 96, sqrt_b - sqrt_a
    if round_up:
        return _ceil_div(_ceil_div(n1 * n2, sqrt_b), sqrt_a)
    return (n1 * n2 // sqrt_b) // sqrt_a


def amount1_delta(sqrt_a, sqrt_b, liq, round_up):
    if sqrt_a > sqrt_b:
        sqrt_a, sqrt_b = sqrt_b, sqrt_a
    if round_up:
        return _ceil_div(liq * (sqrt_b - sqrt_a), Q96)
    return liq * (sqrt_b - sqrt_a) // Q96


def position_amounts(tick_lower, tick_upper, tick, sqrt_p, liq, round_up):
    """Unsigned amounts backing |liq| in [tick_lower, tick_upper) at (tick, sqrt_p)."""
    sa, sb = sqrt_ratio_at_tick(tick_lower), sqrt_ratio_at_tick(tick_upper)
    if tick < tick_lower:
        return amount0_delta(sa, sb, liq, round_up), 0
    if tick < tick_upper:
        return amount0_delta(sqrt_p, sb, liq, round_up), amount1_delta(sa, sqrt_p, liq, round_up)
    return 0, amount1_delta(sa, sb, liq, round_up)


# ------------------------------------------------------------------- rpc ------
class Rpc:
    def __init__(self, url):
        self.url = url
        self.n = 0

    def call(self, method, params):
        self.n += 1
        body = json.dumps({"jsonrpc": "2.0", "id": self.n, "method": method, "params": params}).encode()
        req = urllib.request.Request(self.url, data=body, headers={"content-type": "application/json"})
        with urllib.request.urlopen(req, timeout=60) as r:
            resp = json.loads(r.read())
        if "error" in resp:
            raise RuntimeError(resp["error"])
        return resp["result"]

    def logs(self, address, topics, from_block, to_block):
        out, chunk, start = [], 100_000, from_block
        while start <= to_block:
            end = min(start + chunk - 1, to_block)
            try:
                got = self.call("eth_getLogs", [{
                    "address": address, "topics": topics,
                    "fromBlock": hex(start), "toBlock": hex(end),
                }])
            except Exception as e:  # too many results / range too wide: halve and retry
                if chunk <= 500:
                    raise
                chunk //= 2
                print(f"    getLogs {start}-{end} failed ({str(e)[:70]}), chunk -> {chunk}", file=sys.stderr)
                time.sleep(0.5)
                continue
            out.extend(got)
            print(f"    {start}-{end}: {len(got)} logs (total {len(out)})", file=sys.stderr)
            start = end + 1
            if len(got) < 2000 and chunk < 100_000:
                chunk *= 2
            time.sleep(0.2)
        return out


def s_int(word_hex: str, bits: int) -> int:
    v = int(word_hex, 16)
    return v - (1 << bits) if v >= (1 << (bits - 1)) else v


def words(data_hex: str):
    d = data_hex[2:]
    return [d[i:i + 64] for i in range(0, len(d), 64)]


def decimals_of(rpc, addr):
    if int(addr, 16) == 0:
        return 18
    res = rpc.call("eth_call", [{"to": addr, "data": "0x313ce567"}, "latest"])
    return int(res, 16) if res and res != "0x" else 18


# ------------------------------------------------------------------ main ------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pool_id")
    ap.add_argument("--rpc", default="https://ethereum-rpc.publicnode.com")
    ap.add_argument("--pool-manager", default="0x000000000004444c5dc75cB358380D2e3dE08A90")
    ap.add_argument("--from", dest="from_block", type=int, default=21688329)
    args = ap.parse_args()
    pool_id = args.pool_id.lower()
    rpc = Rpc(args.rpc)
    head = int(rpc.call("eth_blockNumber", []), 16)
    print(f"head {head}; fetching PoolManager logs for {pool_id}", file=sys.stderr)

    logs = []
    for t in (TOPIC_INIT, TOPIC_PROTOCOL_FEE, TOPIC_MODIFY, TOPIC_SWAP):
        logs += rpc.logs(args.pool_manager, [t, pool_id], args.from_block, head)
    logs.sort(key=lambda l: (int(l["blockNumber"], 16), int(l["logIndex"], 16)))
    if not logs or logs[0]["topics"][0] != TOPIC_INIT:
        sys.exit("no Initialize found for this pool in range")

    # accumulators (raw token units)
    up0 = up1 = 0                     # upstream: gross in - out
    fx0 = fx1 = Fraction(0)           # fixed: in net of Swap.fee - out
    lp0 = lp1 = Fraction(0)           # leaked LP fees
    pr0 = pr1 = Fraction(0)           # leaked protocol fees
    ml0 = ml1 = 0                     # ModifyLiquidity net
    positions = {}                    # (tickLower, tickUpper) -> net liquidity
    proto_0for1 = proto_1for0 = 0
    fee_timeline = []
    tick = sqrt_p = None
    last_liq = None
    n_swaps = n_mods = 0
    token0 = token1 = None

    for l in logs:
        t0, w = l["topics"][0], words(l["data"])
        blk = int(l["blockNumber"], 16)
        if t0 == TOPIC_INIT:
            token0 = "0x" + l["topics"][2][-40:]
            token1 = "0x" + l["topics"][3][-40:]
            lp_fee_init = int(w[0], 16)
            sqrt_p = int(w[3], 16)
            tick = s_int(w[4], 24)
            print(f"Initialize @{blk}: fee {lp_fee_init} tickSpacing {s_int(w[1], 24)} hooks 0x{w[2][-40:]}")
        elif t0 == TOPIC_PROTOCOL_FEE:
            packed = int(w[0], 16)
            proto_0for1, proto_1for0 = packed & 0xfff, (packed >> 12) & 0xfff
            fee_timeline.append((blk, proto_0for1, proto_1for0))
            print(f"ProtocolFeeUpdated @{blk}: packed {packed} -> zeroForOne {proto_0for1} oneForZero {proto_1for0}")
        elif t0 == TOPIC_MODIFY:
            n_mods += 1
            tl, tu, dl = s_int(w[0], 24), s_int(w[1], 24), s_int(w[2], 256)
            a0, a1 = position_amounts(tl, tu, tick, sqrt_p, abs(dl), dl > 0)
            if dl < 0:
                a0, a1 = -a0, -a1
            ml0 += a0
            ml1 += a1
            positions[(tl, tu)] = positions.get((tl, tu), 0) + dl
        elif t0 == TOPIC_SWAP:
            n_swaps += 1
            d0, d1 = s_int(w[0], 128), s_int(w[1], 128)  # swapper deltas: negative = paid in
            a0, a1 = -d0, -d1                             # pool perspective
            fee = int(w[5], 16)
            zero_for_one = d0 < 0
            proto = proto_0for1 if zero_for_one else proto_1for0
            up0 += a0
            up1 += a1
            if a0 > 0:
                gross = Fraction(a0)
                fx0 += gross * (1_000_000 - fee) / 1_000_000
                pr0 += gross * proto / 1_000_000
                lp0 += gross * (fee - proto) / 1_000_000
            else:
                fx0 += a0
            if a1 > 0:
                gross = Fraction(a1)
                fx1 += gross * (1_000_000 - fee) / 1_000_000
                pr1 += gross * proto / 1_000_000
                lp1 += gross * (fee - proto) / 1_000_000
            else:
                fx1 += a1
            sqrt_p = int(w[2], 16)
            last_liq = int(w[3], 16)
            tick = s_int(w[4], 24)

    # true reserves from position ranges at the final (tick, sqrt_p)
    tr0 = tr1 = 0
    active = 0
    for (tl, tu), liq in positions.items():
        if liq <= 0:
            if liq < 0:
                print(f"WARNING negative net liquidity {liq} in [{tl},{tu})")
            continue
        a0, a1 = position_amounts(tl, tu, tick, sqrt_p, liq, False)
        tr0 += a0
        tr1 += a1
        if tl <= tick < tu:
            active += liq

    dec0, dec1 = decimals_of(rpc, token0), decimals_of(rpc, token1)
    f0, f1 = Fraction(10) ** dec0, Fraction(10) ** dec1

    def fmt(x, f):
        return f"{float(Fraction(x) / f):,.6f}"

    print()
    print(f"pool {pool_id}")
    print(f"token0 {token0} ({dec0} dec)  token1 {token1} ({dec1} dec)")
    print(f"events: {n_swaps} swaps, {n_mods} modifyLiquidity, {len(fee_timeline)} protocol fee updates")
    print(f"final tick {tick}, active liquidity from positions {active} vs last Swap.liquidity {last_liq}"
          f" -> {'MATCH' if last_liq is None or active == last_liq else 'MISMATCH'}")
    print()
    print(f"{'':28}{'token0':>24}{'token1':>24}")
    print(f"{'modifyLiquidity net':28}{fmt(ml0, f0):>24}{fmt(ml1, f1):>24}")
    print(f"{'upstream TVL (subgraph)':28}{fmt(up0 + ml0, f0):>24}{fmt(up1 + ml1, f1):>24}")
    print(f"{'fixed TVL (this branch)':28}{fmt(fx0 + ml0, f0):>24}{fmt(fx1 + ml1, f1):>24}")
    print(f"{'true TVL (positions)':28}{fmt(tr0, f0):>24}{fmt(tr1, f1):>24}")
    print()
    print(f"{'upstream - fixed':28}{fmt(up0 - fx0, f0):>24}{fmt(up1 - fx1, f1):>24}")
    print(f"{'  = LP fees leaked':28}{fmt(lp0, f0):>24}{fmt(lp1, f1):>24}")
    print(f"{'  + protocol fees leaked':28}{fmt(pr0, f0):>24}{fmt(pr1, f1):>24}")
    print(f"{'fixed - true (dust)':28}{fmt(fx0 + ml0 - tr0, f0):>24}{fmt(fx1 + ml1 - tr1, f1):>24}")
    if (up0 + ml0) and (up1 + ml1) and tr0 and tr1:
        print(f"{'upstream / true':28}{float(Fraction(up0 + ml0) / tr0):>24.4f}{float(Fraction(up1 + ml1) / tr1):>24.4f}")
        print(f"{'fixed / true':28}{float((fx0 + ml0) / tr0):>24.6f}{float((fx1 + ml1) / tr1):>24.6f}")


if __name__ == "__main__":
    main()
