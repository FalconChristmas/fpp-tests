"""The If command's Check and the expressions behind it and Set Variable:
condition groups, numeric and text comparisons, formulas in Name and Value,
the Sun and GPIO sources, sequential and parallel command lists, the
editor's preview and validation routes, and tinyexpr's operators and
functions."""

import http.server
import itertools
import datetime
import json
import math
import threading
import time
import urllib.parse

import pytest


def set_variable(name, value):
    return {"command": "Set Variable", "args": [name, "Value", str(value), "1", "0", "100", ""]}


def variable(fppd, name):
    """One variable's value, "" if it isn't set."""
    return str(fppd.get("/variables/" + urllib.parse.quote(name), timeout=5))


def leaf(name, comparator, value, source="Expression", negate=False):
    return {"source": source, "name": name, "comparator": comparator, "value": value, "not": negate}


def group(op, *conditions, negate=False):
    return {"op": op, "not": negate, "conditions": list(conditions)}


TRUE = leaf("1", "equal to", "1")
FALSE = leaf("1", "equal to", "2")

_names = itertools.count()


def check(fppd, cond):
    """Runs an If with cond as its Check: "yes" if it ran Then, "no" if it
    ran Otherwise."""
    name = f"If{next(_names)}"
    fppd.post("/command", {"command": "If", "args": [
        json.dumps(cond), json.dumps([set_variable(name, "yes")]), "Sequential",
        json.dumps([set_variable(name, "no")]), "Sequential"]})
    return fppd.wait_for(lambda: variable(fppd, name), timeout=5, what=f"the If on {cond}")


def set_vars(fppd, **kv):
    for k, v in kv.items():
        fppd.command("Set Variable", k, "Value", v, "1", "0", "100", "")


def evaluate(fppd, expression):
    """Set Variable's Expression mode: what fppd computes for expression."""
    name = f"Expr{next(_names)}"
    fppd.post("/command", {"command": "Set Variable",
                           "args": [name, "Expression", "", "1", "0", "100", expression]})
    return variable(fppd, name)


GROUPS = [
    (group("AND", TRUE, TRUE), "yes"),
    (group("AND", TRUE, FALSE), "no"),
    (group("AND", FALSE, TRUE), "no"),
    (group("OR", FALSE, TRUE), "yes"),
    (group("OR", FALSE, FALSE), "no"),
    (group("AND", TRUE, TRUE, negate=True), "no"),
    (group("OR", FALSE, FALSE, negate=True), "yes"),
    # A NOT leaf inside a group, and a group inside a group.
    (group("AND", TRUE, leaf("1", "equal to", "2", negate=True)), "yes"),
    (group("OR", FALSE, group("AND", TRUE, TRUE)), "yes"),
    (group("AND", TRUE, group("OR", FALSE, FALSE)), "no"),
    # Nothing to check: AND of nothing holds, OR of nothing doesn't.
    (group("AND"), "yes"),
    (group("OR"), "no"),
    # An op other than OR is AND.
    (group("XOR", TRUE, FALSE), "no"),
    # A child that is neither a group nor a leaf is dropped, not counted.
    (group("AND", {"bogus": 1}, TRUE), "yes"),
    (group("OR", {"bogus": 1}, FALSE), "no"),
]


def test_groups_combine_their_conditions(fppd):
    """An If's Check with several conditions: ALL (AND) or ANY (OR) of
    them, NOT on a group or a leaf, groups nested in groups, and a child
    that can't be read dropped rather than taken as true or false."""
    fppd.start()
    wrong = {}
    for i, (cond, want) in enumerate(GROUPS):
        got = check(fppd, cond)
        if got != want:
            wrong[i] = (json.dumps(cond), got, want)
    assert not wrong, f"wrong answers (index: check, got, wanted): {wrong}"


COMPARISONS = [
    # Numbers compare as numbers: "10" sorts before "9" as text.
    ("Count", "greater than", "9", "yes"),
    ("Count", "less than", "9", "no"),
    ("Count", "greater or equal", "10", "yes"),
    ("Count", "less or equal", "10.0", "yes"),
    ("Count", "equal to", "10.0", "no"),  # equal to is always text
    ("Count", "not equal to", "11", "yes"),
    ("Count", "between", "5,20", "yes"),
    ("Count", "between", "20,5", "yes"),  # a reversed numeric range is the same range
    ("Count", "between", "11,20", "no"),
    ("Count", "between", "5", "no"),  # no comma
    ("Count", "between", "5,x", "no"),  # a bound that isn't a number
    # Only a whole number is a number: "10abc" is text, so it compares as text.
    ("Mixed", "greater than", "9", "no"),
    ("Mixed", "less than", "9", "yes"),
    ("Word", "contains", "ell", "yes"),
    ("Word", "contains", "xyz", "no"),
    ("Word", "greater than", "abc", "yes"),
    ("Word", "less or equal", "abc", "no"),
    ("Word", "no such comparator", "hello", "no"),
    # A name that is no variable is the text itself.
    ("Unset", "equal to", "Unset", "yes"),
]


def test_comparators(fppd):
    """Every comparator, on numbers, text that starts with digits, and words."""
    fppd.start()
    set_vars(fppd, Count="10", Mixed="10abc", Word="hello")
    wrong = {}
    for name, cmp_, value, want in COMPARISONS:
        got = check(fppd, leaf(name, cmp_, value))
        if got != want:
            wrong[(name, cmp_, value)] = got
    assert not wrong, f"wrong answers: {wrong}"


FORMULAS = [
    # Value is computed when it looks like a formula, with no "=" needed.
    ("Count", "equal to", "count*2", "yes"),
    ("Count", "equal to", "=count*2", "yes"),
    ("Count", "equal to", "%%Count%%", "yes"),
    ("Count", "equal to", "1==count-5==", "yes"),  # "1" then "0"
    # Name too: a bare formula on the left.
    ("count+1", "equal to", "6", "yes"),
    # Names with '-' and '/' in them are names, not subtraction, whole or in
    # a formula.
    ("Score-Total", "equal to", "7", "yes"),
    ("Score-Total+1", "equal to", "8", "yes"),
    ("Score-Total", "less than", "Score-Total+1", "yes"),
    ("a/b", "equal to", "3", "yes"),
    # Plain text that is no variable stays text.
    ("Word", "equal to", "ON", "yes"),
    ("Word", "equal to", "OFF", "no"),
    # Value can be another variable.
    ("Count", "greater than", "count", "yes"),
    ("count", "equal to", "Five", "yes"),
]


def test_formulas_and_variables_in_name_and_value(fppd):
    """Check's Name and Value read a variable when they name one exactly,
    compute a formula when they look like one ("=" or "%%name%%" optional),
    and are plain text otherwise; variable names with '-' and '/' in them
    stay names, also inside a formula."""
    fppd.start()
    set_vars(fppd, Count="10", count="5", Five="5", Word="ON", **{"Score-Total": "7", "a/b": "3"})
    wrong = {}
    for name, cmp_, value, want in FORMULAS:
        got = check(fppd, leaf(name, cmp_, value))
        if got != want:
            wrong[(name, cmp_, value)] = got
    assert not wrong, f"wrong answers: {wrong}"


def test_status_sources(fppd):
    """Player Status, Is Playing, Current Playlist, a GPIO pin nothing has
    set (not found: false, true with NOT) and an unknown source."""
    fppd.start()
    assert check(fppd, leaf("", "equal to", "idle", source="Player Status")) == "yes"
    assert check(fppd, leaf("", "equal to", "0", source="Is Playing")) == "yes"
    assert check(fppd, leaf("", "equal to", "", source="Current Playlist")) == "yes"
    assert check(fppd, leaf("P8-07", "equal to", "0", source="GPIO Pin")) == "no"
    assert check(fppd, leaf("P8-07", "equal to", "0", source="GPIO Pin", negate=True)) == "yes"
    assert check(fppd, leaf("x", "equal to", "", source="No Such Source")) == "no"


def preview(fppd, **params):
    return fppd.get("/fppd/condition/preview?" + urllib.parse.urlencode(params))


def almanac(lat, lon, day, utc_offset, rising):
    """Sunrise or sunset in minutes after local midnight, by the US Naval
    Observatory's almanac approximation -- a different algorithm from FPP's
    SunRise, so the two agree to a few minutes, not exactly."""
    sin, cos, rad, deg = math.sin, math.cos, math.radians, math.degrees
    t = day.timetuple().tm_yday + ((6 if rising else 18) - lon / 15) / 24
    m = 0.9856 * t - 3.289
    sun_lon = (m + 1.916 * sin(rad(m)) + 0.020 * sin(rad(2 * m)) + 282.634) % 360
    ra = deg(math.atan(0.91764 * math.tan(rad(sun_lon)))) % 360
    ra = (ra + (sun_lon // 90) * 90 - (ra // 90) * 90) / 15
    sin_dec = 0.39782 * sin(rad(sun_lon))
    cos_h = ((cos(rad(90.833)) - sin_dec * sin(rad(lat)))
             / (cos(math.asin(sin_dec)) * cos(rad(lat))))
    h = deg(math.acos(cos_h))
    h = (360 - h if rising else h) / 15
    hours = (h + ra - 0.06571 * t - 6.622 - lon / 15 + utc_offset) % 24
    return hours * 60


def minutes(hhmm):
    h, m = hhmm.split(":")
    return int(h) * 60 + int(m)


SUN = [
    # No Latitude/Longitude: FPP's own default, near Colorado Springs.
    ({}, (38.938524, -104.600945), "America/Denver", -6),
    ({"Latitude": "-33.8688", "Longitude": "151.2093"}, (-33.8688, 151.2093),
     "Australia/Sydney", 11),
]


@pytest.mark.parametrize("where, at, tz, utc_offset", SUN, ids=["default", "sydney"])
def test_sun_source_uses_the_location_and_time_zone(fppd, where, at, tz, utc_offset):
    """The Sun source is today's sunrise or sunset as HH:MM local time, for
    the Latitude and Longitude settings (or FPP's default place without
    them), and compares as a time of day."""
    fppd.settings(**where)
    fppd.start(fake_time="2026-10-17 12:00:00", tz=tz)
    times = {}
    for which in ("Sunrise", "Sunset"):
        r = preview(fppd, source="Sun", name=which)
        assert r["found"], r
        times[which] = r["value"]
        want = almanac(*at, datetime.date(2026, 10, 17), utc_offset, which == "Sunrise")
        assert abs(minutes(r["value"]) - want) <= 5, \
            f"{which} {r['value']}, the almanac says {int(want) // 60:02d}:{int(want) % 60:02d}"
    # 12:00 is between them, as times not text.
    assert check(fppd, leaf("Sunrise", "less than", "12:00", source="Sun")) == "yes"
    assert check(fppd, leaf("Sunset", "greater than", "12:00", source="Sun")) == "yes"
    assert check(fppd, leaf("", "between", f"{times['Sunrise']},{times['Sunset']}",
                            source="Time")) == "yes"


def test_condition_preview(fppd):
    """GET /api/fppd/condition/preview: one source's value, or with a
    comparator the whole leaf -- both sides and the result, as If would
    evaluate it."""
    fppd.start()
    set_vars(fppd, Count="10")
    r = preview(fppd, source="Expression", name="Count")
    assert (r["found"], r["value"]) == (True, "10"), r
    r = preview(fppd, source="Expression", name="Count", comparator="greater than", value="Count-1")
    assert (r["found"], r["value"], r["rhsValue"], r["result"]) == (True, "10", "9", True), r
    r = preview(fppd, source="Expression", name="Count", comparator="greater than", value="9",
                **{"not": "true"})
    assert r["result"] is False, r
    # A source that doesn't resolve: no value, and the result is the NOT.
    assert preview(fppd, source="GPIO Pin", name="P9-12")["found"] is False
    r = preview(fppd, source="GPIO Pin", name="P9-12", comparator="equal to", value="1",
                **{"not": "true"})
    assert (r["found"], r["rhsValue"], r["result"]) == (False, "1", True), r


VALIDATE = [
    # The If editor's fields (conditionExpr=true).
    ("Count", True, True, "variable"),
    ("Count+1", True, True, "formula"),
    ("=sqrt(Count)", True, True, "formula"),
    ("Count+(", True, False, "formula"),
    ("ON", True, True, "literal"),
    # Set Variable's Expression field.
    ("=1+2", False, True, "formula"),
    ("=1+", False, False, "formula"),
    ("a %%Count%% b", False, True, "template"),
    ("a %%Nope%% b", False, False, "template"),
    ("Count", False, True, "literal"),
]


def test_validate_expression(fppd):
    """GET /api/variables?validateExpression= says whether a field compiles
    and how it will be read: a variable, a formula, a template or plain
    text."""
    fppd.start()
    set_vars(fppd, Count="10")
    wrong = {}
    for text, cond, valid, kind in VALIDATE:
        q = {"validateExpression": text} | ({"conditionExpr": "true"} if cond else {})
        r = fppd.get("/variables?" + urllib.parse.urlencode(q))
        if (r.get("valid"), r.get("kind")) != (valid, kind):
            wrong[(text, cond)] = r
    assert not wrong, f"wrong answers: {wrong}"


class SlowServer:
    """An HTTP server that answers every request after `delay` seconds."""

    def __init__(self, delay):
        self.hits = []
        hits = self.hits

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                time.sleep(delay)
                hits.append(time.monotonic())
                self.send_response(200)
                self.send_header("Content-Length", "2")
                self.end_headers()
                self.wfile.write(b"ok")

            def log_message(self, *a):
                pass

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}/hook"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


@pytest.mark.parametrize("mode", ["Sequential", "Parallel"])
def test_sequential_commands_wait_for_the_one_before(fppd, mode):
    """Then Run with a slow URL command first: Sequential starts the next
    command only once the URL has answered, Parallel at once, and neither
    holds up the caller."""
    server = SlowServer(2.0)
    try:
        fppd.start()
        cmds = [{"command": "URL", "args": [server.url, "GET", ""]},
                set_variable("After", "1"), set_variable("Last", "1")]
        began = time.monotonic()
        fppd.post("/command", {"command": "If", "args": [
            json.dumps(TRUE), json.dumps(cmds), mode, "", "Sequential"]})
        assert time.monotonic() - began < 1.0, "the If waited for its commands"
        fppd.wait_for(lambda: variable(fppd, "Last") == "1", timeout=10,
                      what="the last command in the list")
        done = time.monotonic()
        if mode == "Sequential":
            assert server.hits, "the next command ran before the URL answered"
            assert server.hits[0] <= done
        else:
            assert not server.hits, "Parallel waited for the URL"
        assert variable(fppd, "After") == "1"
        fppd.wait_for(lambda: server.hits, timeout=10, what="the URL to be fetched")
    finally:
        server.close()


EXPRESSIONS = [
    ("=10-4", "6"),
    ("=7/2", "3.5"),
    ("=-3+1", "-2"),
    ("=2^10", "1024"),
    ("=7%3", "1"),
    ("=(1,2)", "2"),
    ("=2*(3+4)", "14"),
    ("=abs -3", "3"),
    ("=floor(2.7)+ceil(2.2)", "5"),
    ("=sqrt(16)", "4"),
    ("=pow(2,3)", "8"),
    ("=log10(1000)", "3"),
    ("=log(100)", "2"),
    ("=ln(e)", "1"),
    ("=exp(0)", "1"),
    ("=pi", "3.141593"),
    ("=atan2(1,1)*4", "3.141593"),
    ("=sin(0)+cos(0)+tan(0)", "1"),
    ("=asin(1)*2", "3.141593"),
    ("=acos(1)+atan(0)", "0"),
    ("=sinh(0)+cosh(0)+tanh(0)", "1"),
    ("=fac(5)", "120"),
    ("=fac(0)", "1"),
    ("=ncr(5,2)", "10"),
    ("=npr(5,2)", "20"),
    ("=rgb(1,2,3)", "66051"),
    ("=rgb(255,255,255)", "16777215"),
    ("=hsv(0,0,1)", "16777215"),  # no saturation: grey
    ("=hsv(0,1,1)", "16711680"),  # red
    ("=hsv(1/6,1,1)", "16776960"),  # yellow
    ("=hsv(1/3,1,1)", "65280"),  # green
    ("=hsv(1/2,1,1)", "65535"),  # cyan
    ("=hsv(2/3,1,1)", "255"),  # blue
    ("=hsv(5/6,1,1)", "16711935"),  # magenta
    ("=hsv(0,1,0.5)", "8323072"),  # dark red
    # The hue wraps round the wheel (regression: f44650e15, where 1.0 and
    # past it came out magenta).
    ("=hsv(1,1,1)", "16711680"),  # red again
    ("=hsv(1.5,1,1)", "65535"),  # cyan, as 0.5
    ("=hsv(-0.25,1,1)", "8323327"),  # violet, as 0.75
    # A hue that isn't a number is red (f44650e15: it was cast from NaN to
    # int, which is undefined; arm64 happens to give red, x86 does not).
    ("=hsv(1/0,1,1)", "16711680"),
    ("=hsv(0/0,1,1)", "16711680"),
    ("=if(1,5,6)", "5"),
    ("=if(0,5,6)", "6"),
    ("=if(count-5,5,6)", "6"),
    ("=count*2", "10"),
    ("=1/0", "inf"),
    ("=1e30", "1000000000000000019884624838656"),
    # Templates: text with ==math== and %%variable%% in it.
    ("a==1+1==b", "a2b"),
    ("x%%Word%%y", "xONy"),
    ("==count==/==count*2==", "5/10"),
    ("plain", "plain"),
]


def test_expression_operators_and_functions(fppd):
    """Set Variable's Expression mode: every tinyexpr operator, its built-in
    functions and FPP's own rgb(), hsv() and if(), variables, and the
    ==math== and %%variable%% templates."""
    fppd.start()
    set_vars(fppd, count="5", Word="ON")
    wrong = {}
    for expr, want in EXPRESSIONS:
        got = evaluate(fppd, expr)
        if got != want:
            wrong[expr] = (got, want)
    assert not wrong, f"wrong values (got, wanted): {wrong}"


@pytest.mark.parametrize("expr", ["=1+", "=nosuchfunc(1)", "=2 $ 3", "a %%Nope%% b"])
def test_an_expression_that_does_not_compile_sets_nothing(fppd, expr):
    """A Set Variable expression that doesn't compile is refused and leaves
    the variable as it was."""
    fppd.start()
    set_vars(fppd, Target="before")
    try:
        fppd.post("/command", {"command": "Set Variable",
                               "args": ["Target", "Expression", "", "1", "0", "100", expr]})
    except Exception as e:  # noqa: BLE001 -- refused is right
        print(f"{expr!r} answered: {e}")
    assert variable(fppd, "Target") == "before"
