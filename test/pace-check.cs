// The bottleneck's two parts on their own (2.0.1): Frames.Pace (is the game's frame pace held by a cap?) on made-up
// present time stamps, and Bottleneck.Second's call from GPU usage, the busiest thread and that pace. Built with the
// app's code and run by test\pace-check.ps1 (no window, no HWiNFO):
//   pace-check.exe   prints PASS / FAIL per case, then ALL PASS or SOME FAILED
using System;
using System.Collections.Generic;
using System.Linq;

static class PaceCheck
{
    const long F = 10000000;   // ticks a second (QPC runs at 10 MHz on most PCs)
    static int fails, runs;
    static void Ok(string name, bool cond, string seen = null) { runs++; if (!cond) fails++; Console.WriteLine((cond ? "PASS " : "FAIL ") + name + (seen != null ? "  (" + seen + ")" : "")); }
    static string S(bool? b) { return b == null ? "unknown" : b.Value ? "held" : "not held"; }

    // frames whose rate is given per 0.5 s slice, the newest slice last, ending now
    static List<long> Slices(params double[] fps)
    {
        var ts = new List<long>(); long t0 = 1000 * F - fps.Length * F / 2;
        for (int j = 0; j < fps.Length; j++)
        {
            long a = t0 + j * F / 2, b = a + F / 2; if (fps[j] <= 0) continue;
            for (double t = a; t < b; t += F / fps[j]) ts.Add((long)t);
        }
        ts.Add(t0 + fps.Length * F / 2);
        return ts;
    }
    // a frame limiter that aims at fixed times (deadlines): each frame lands off its deadline by up to jit (a part of
    // the interval) either way, so frame times swing while the rate holds
    static List<long> Deadline(double fps, double jit, double secs, int seed = 1)
    {
        var r = new Random(seed); var ts = new List<long>(); long end = 1000 * F; double step = F / fps;
        for (double k = 0; k * step <= secs * F; k++) ts.Add(end - (long)(k * step) + (long)(step * jit * (2 * r.NextDouble() - 1)));
        ts.Sort(); return ts;
    }
    // each frame takes its own time off the last (a sleep, a game's own work): off by up to jit, the rate wandering by
    // swing over period seconds (a game's load changing)
    static List<long> Relative(double fps, double jit, double swing, double period, double secs, int seed = 1)
    {
        var r = new Random(seed); var ts = new List<long>(); long end = 1000 * F;
        for (long t = end; t > end - (long)(secs * F); )
        {
            ts.Add(t);
            double now = fps * (1 + swing * Math.Sin(2 * Math.PI * t / (period * F)));
            t -= (long)(F / now * (1 + jit * (2 * r.NextDouble() - 1)));
        }
        ts.Reverse(); return ts;
    }
    static bool? P(List<long> ts, long now = 1000 * F) { return Frames.Pace(ts, now, F); }

    // a session's line in games.log as Games.Line writes it: per minute its [gpu, cpu, capped] seconds (null: none) and
    // its average fps (null: none); its totals and timeline letters from those
    static readonly System.Web.Script.Serialization.JavaScriptSerializer js = new System.Web.Script.Serialization.JavaScriptSerializer();
    static string Sess(long start, int[][] tc, double?[] tf, string extra = null)
    {
        Func<int, int> sum = k => tc.Where(x => x != null).Sum(x => x[k]);
        var tb = new string(tc.Select(x => x == null ? '-' : x[1] >= x[0] && x[1] >= x[2] ? 'c' : x[0] >= x[2] ? 'g' : 'f').ToArray());
        var d = new Dictionary<string, object> { { "game", "Test game" }, { "start", start }, { "end", start + tc.Length * 60 }, { "from", start }, { "secs", tc.Length * 60 }, { "front", sum(0) + sum(1) + sum(2) },
            { "fps", 251.5 }, { "low", 120 }, { "items", new object[] { new object[] { "GPU temp", "°C", 61.125, 70.25, null, null, 1, null, 0, "k.0/01000000", 0 } } }, { "warns", 1 },
            { "g", sum(0) }, { "c", sum(1) }, { "f", sum(2) }, { "wl", new object[] { new object[] { "GPU temp", 70.25, "°C" } } }, { "tf", tf }, { "tl", tf.Select(v => v == null ? null : (double?)Math.Round(v.Value / 2)).ToArray() }, { "tb", tb }, { "tc", tc }, { "p", 3 } };
        var s = js.Serialize(d);
        return extra == null ? s : s.Substring(0, s.Length - 1) + "," + extra + "}";
    }
    static Dictionary<string, object> D(string line) { return (Dictionary<string, object>)js.DeserializeObject(line); }
    static int I(Dictionary<string, object> d, string k) { return Convert.ToInt32(d[k]); }
    static int[][] Mins(int n, Func<int, int[]> f) { return Enumerable.Range(0, n).Select(f).ToArray(); }
    static double?[] Fps(int n, Func<int, double?> f) { return Enumerable.Range(0, n).Select(f).ToArray(); }
    const long Old = Games.PaceRuleSince - 30 * 86400, New = Games.PaceRuleSince + 3600;

    static int Main(string[] args)
    {
        // (local: pace-check.exe reest <file>: that file's sessions re-estimated in place, a copy beside it first)
        if (args.Length == 2 && args[0] == "reest") { Games.ReestimateFiles(new[] { args[1] }, new object(), Console.WriteLine); return 0; }
        // ---- the pace: held ----
        Ok("a cap at 240 with one dip: held", P(Slices(240, 239.9, 240.1, 240, 228.4, 240, 239.8, 240.1, 240, 239.9)) == true);
        Ok("60 Hz vsync, one missed vblank in a slice: held", P(Slices(60, 60, 60, 60, 58.1, 60, 60, 60, 60, 60)) == true);
        Ok("Reflex's cap at 225 on a 240 Hz G-Sync screen: held", P(Slices(224.6, 225.1, 224.9, 225, 224.8, 225.1, 224.7, 225, 224.9, 225)) == true);
        Ok("a 30 fps cap: held", P(Deadline(30, 0.05, 6)) == true, S(P(Deadline(30, 0.05, 6))));
        Ok("a 400 cap aiming at fixed times, each frame off by up to 40%: held", P(Deadline(400, 0.4, 6)) == true, S(P(Deadline(400, 0.4, 6))));
        Ok("a 144 cap aiming at fixed times, off by up to 90%: held", P(Deadline(144, 0.9, 6)) == true, S(P(Deadline(144, 0.9, 6))));
        Ok("1000 fps capped (a menu): held", P(Deadline(1000, 0.2, 6)) == true);
        Ok("frame generation under a cap: 2 frames each 8.3 ms, 3 and 5.3 ms apart: held", P(Pairs(120, 3.0, 6)) == true);
        // ---- not held ----
        Ok("11-03 Deadlock uncapped (slices 255 to 320): not held", P(Slices(290, 270, 310, 255, 300, 280, 265, 320, 295, 275)) == false);
        Ok("uncapped, the per-second counts flat (301, 296, 305, 299, 303) but the half seconds not: not held", P(Slices(285, 318, 290, 310, 296, 314, 288, 306, 300, 309)) == false);
        Ok("uncapped, the load swinging 8% over 1.3 s: not held", P(Relative(280, 0.15, 0.08, 1.3, 6)) == false, S(P(Relative(280, 0.15, 0.08, 1.3, 6))));
        Ok("uncapped, the load swinging 5% over 2.5 s: not held", P(Relative(280, 0.1, 0.05, 2.5, 6)) == false, S(P(Relative(280, 0.1, 0.05, 2.5, 6))));
        Ok("vsync 60 dropping to 30 and back: not held", P(Slices(60, 60, 30, 30, 60, 45, 60, 30, 60, 60)) == false);
        Ok("frame generation uncapped (slices 410 to 480): not held", P(Slices(470, 430, 455, 410, 480, 445, 425, 460, 440, 415)) == false);
        Ok("an adaptive limiter (Chill) moving between 70 and 140: not held", P(Slices(140, 140, 120, 100, 90, 70, 70, 90, 120, 140)) == false);
        // ---- nothing to tell by ----
        var paused = Deadline(240, 0.1, 6);
        Ok("the newest frame 2 s old (paused, alt-tab): unknown", P(paused, 1002 * F) == null);
        Ok("the newest frame 0.9 s old: still told", P(paused, 1000 * F + 9 * F / 10) == true);
        Ok("a load: three slices without frames: unknown", P(Slices(240, 240, 0, 0, 0, 240, 240, 240, 240, 240)) == null);
        Ok("two slices without frames: told (8 left)", P(Slices(240, 240, 0, 0, 240, 240, 240, 240, 240, 240)) == true);
        Ok("in front for 3 s: unknown", P(Deadline(240, 0.1, 3)) == null);
        Ok("12 fps: unknown", P(Deadline(12, 0.05, 6)) == null);
        Ok("no frames at all: unknown", P(new List<long>()) == null);
        Ok("a handful of frames: unknown", P(new List<long> { 1, 2, 3, 4, 5 }) == null);
        // ---- known wrong, kept so a change of it shows ----
        Ok("(known: uncapped standing still at 412 +-1 fps reads held)", P(Slices(412, 410, 413, 411, 409, 412, 414, 410, 411, 412)) == true);

        // ---- the call ----
        var src = new Fake(); var b = new Bottleneck(); b.Find(src);
        Func<double, double, bool?, char> call = (g, c, s) => { src.Set(g, c); b.Second(src, true, s); return b.Call; };
        Ok("GPU 97%: GPU bound, whatever the pace", call(97, 50, true) == 'g' && call(97, 50, false) == 'g' && call(97, 90, null) == 'g');
        Ok("GPU 63%, thread 74%, pace not held (11-03 Deadlock): CPU bound", call(63, 74, false) == 'c');
        Ok("GPU 63%, thread 74%, pace held: FPS capped", call(63, 74, true) == 'f');
        Ok("GPU 63%, thread 82%, pace held: CPU bound (a thread at 80%+ wins)", call(63, 82, true) == 'c');
        Ok("GPU 40%, thread 50%, a game without its frames counted: CPU bound", call(40, 50, null) == 'c');
        call(97, 50, null); Ok("GPU 88 to 90% after GPU bound, the pace not held or unknown: still GPU bound", call(90, 50, false) == 'g' && call(88, 50, null) == 'g');
        call(60, 50, true); Ok("GPU 90% after capped: the pace decides (held: capped, not: CPU bound)", call(90, 50, true) == 'f' && call(90, 50, false) == 'c');
        call(60, 50, null); Ok("GPU 88 to 93% after a CPU bound from before the pace was known: capped once it is held (11-03 review)", call(88, 50, true) == 'f' && call(93, 60, true) == 'f');
        src.Set(97, 50); b.Second(src, false, null);
        Ok("a game starting: no GPU bound carried over from the desktop (GPU 88%, pace not held: CPU bound)", b.Live == 'g' && call(88, 50, false) == 'c');
        b = new Bottleneck(); b.Find(src); src.Set(97, 50); b.Second(src, true, false, true);
        Ok("(without the game starting it would hold: GPU 88%, not held, after GPU bound)", call(88, 50, false) == 'g');
        Ok("GPU 88 to 94% after GPU bound, the pace held: capped (11-03 review: a spike to 95% doesn't hold a capped game GPU bound)", call(97, 50, true) == 'g' && call(90, 50, true) == 'f');
        b = new Bottleneck(); b.Find(src);
        Ok("GPU 92%, no call before, the pace held: capped", call(92, 50, true) == 'f');
        // counted but nothing to tell by yet (a load, back from an alt-tab): the call as it was
        Func<double, double, bool?, bool, char> call2 = (g, c, s, n) => { src.Set(g, c); b.Second(src, true, s, n); return b.Call; };
        b = new Bottleneck(); b.Find(src);
        Ok("frames counted, nothing to tell by yet, no call before: CPU bound", call2(60, 50, null, true) == 'c');
        Ok("frames counted, a load after capped: still capped", call2(60, 50, true, true) == 'f' && call2(60, 50, null, true) == 'f' && call2(30, 40, null, true) == 'f');
        Ok("frames counted, a load after CPU bound: still CPU bound", call2(60, 50, false, true) == 'c' && call2(60, 50, null, true) == 'c');
        Ok("frames not counted in a game: CPU bound, whatever came before", call2(60, 50, true, true) == 'f' && call2(60, 50, null, false) == 'c');
        src.Set(40, 30); b.Second(src, false, null, false);
        Ok("no game, nothing counted (the desktop): capped at the screen's pace, as before 2.0.1", b.Live == 'f');
        src.Set(40, 90); b.Second(src, false, null, false);
        Ok("no game, a thread at 90%: CPU bound", b.Live == 'c');
        b = new Bottleneck(); b.Find(src);
        Ok("GPU 92%, no call before, the pace not held: GPU bound", call(92, 50, false) == 'g');
        b = new Bottleneck(); b.Find(src);
        Ok("GPU 87%, no call before, pace held: capped", call(87, 50, true) == 'f');
        b = new Bottleneck(); b.Find(src);
        Ok("GPU 87%, no call before, pace not held: CPU bound", call(87, 50, false) == 'c');
        src.Set(60, 50); b.Second(src, false, true);
        Ok("no game: the call goes on (Live), none counted (Call)", b.Live == 'f' && b.Call == '-' && double.IsNaN(b.Value));
        src.Status = "missing"; b.Second(src, true, true);
        Ok("HWiNFO not sharing: no call", b.Call == '-' && b.Live == '-');
        src.Status = "ok";

        // ---- 2.1: a held pace with a busy thread, by the rate's stability ----
        b = new Bottleneck(); b.Find(src);
        Func<double, double, bool?, bool, char> call3 = (g, c, s, st) => { src.Set(g, c); b.Second(src, true, s, true, st); return b.Call; };
        Ok("held, a thread at 85%, the rate put for 30 s: FPS capped (a capped game with one hot thread)", call3(60, 85, true, true) == 'f');
        Ok("held, a thread at 85%, the rate moving: CPU bound (a steady CPU limit drifts with the scene)", call3(60, 85, true, false) == 'c');
        Ok("not held, a thread at 85%, the rate put: CPU bound (only a held pace is a cap)", call3(60, 85, false, true) == 'c');
        Ok("held, a thread at 50%: FPS capped whatever the rate did", call3(60, 50, true, false) == 'f');
        // the 30 s stability itself
        Func<int, Func<int, double>, bool> st30 = (n, f) => Frames.StableRate(Enumerable.Range(0, n).Select(f));
        Ok("30 s at 119 to 120 fps: stable", st30(30, i => 119 + i % 2));
        Ok("29 s: not yet", !st30(29, i => 119 + i % 2));
        Ok("one second 5% off in 30: not stable", !st30(30, i => i == 12 ? 125 : 119));
        Ok("a CPU limit drifting 4% over 30 s: not stable", !st30(30, i => 200 + i * 0.28));
        Ok("seconds at 0 fps (a pause) don't count toward it", !st30(30, i => i < 3 ? 0 : 144));
        Ok("a 30 fps cap counting 30 or 31 a second: stable (two frames either way)", st30(30, i => 30 + i % 2));
        Ok("a 30 fps cap drifting 27 to 33: not stable", !st30(30, i => 27 + i % 7));

        // ---- 2.1: a game whose frames aren't counted: HWiNFO's fps at the screen's refresh rate (vsync) ----
        b = new Bottleneck(); b.Find(src);
        Func<double, double, char> blind = (pm, hz) => { src.Set(60, 50); b.Second(src, true, null, false, false, hz, pm); return b.Call; };
        var calls = new List<char>(); for (int i = 0; i < 6; i++) calls.Add(blind(239.5, 240));
        Ok("HWiNFO's fps at 240 on a 240 Hz screen: CPU bound for 5 s, then capped (2 or more of its polls)", new string(calls.ToArray()) == "cccccf", new string(calls.ToArray()));
        Ok("and it says it can't see other caps", b.Blind);
        b = new Bottleneck(); b.Find(src); calls.Clear(); for (int i = 0; i < 6; i++) calls.Add(blind(224, 240));
        Ok("at NVIDIA Reflex's cap for 240 Hz (224): capped after 6 s", calls[5] == 'f');
        b = new Bottleneck(); b.Find(src); calls.Clear(); for (int i = 0; i < 6; i++) calls.Add(blind(59.94, 59));
        Ok("a 59.94 Hz screen (Windows says 59) at 59.94 fps: capped after 6 s", calls[5] == 'f');
        b = new Bottleneck(); b.Find(src); calls.Clear(); for (int i = 0; i < 8; i++) calls.Add(blind(i % 2 == 0 ? 200 : 239.5, 240));
        Ok("off the rate now and then: never capped", !calls.Contains('f'));
        b = new Bottleneck(); b.Find(src); calls.Clear(); for (int i = 0; i < 8; i++) calls.Add(blind(double.NaN, 240));
        Ok("no HWiNFO fps (or not the game's): CPU bound", !calls.Contains('f') && calls.All(x => x == 'c'));
        src.Set(60, 50); b.Second(src, true, true, true, false, 240, 240);
        Ok("frames counted: the refresh rate test stays out, not blind", !b.Blind && b.Call == 'f');
        src.Set(40, 30); b.Second(src, false, null, false, false, 240, 240);
        Ok("no game: not blind", !b.Blind);

        // ---- pace.log's numbers (to tune Pace from real games later) ----
        string held = Frames.PaceText(Deadline(240, 0.3, 6), F), own = Frames.PaceText(Relative(240, 0.3, 0, 1, 6), F);
        Func<string, string, double> num = (line, k) => { var a = line.Split(new[] { "  " }, StringSplitOptions.None).First(x => x.StartsWith(k + " ")); return double.Parse(a.Substring(k.Length + 1), System.Globalization.CultureInfo.InvariantCulture); };
        Ok("pace.log, frames held to a clock: fps 240, ac1 near -0.5, q near 4", Math.Abs(num(held, "fps") - 240) < 1 && num(held, "ac1") < -0.35 && num(held, "q") > 3, held);
        Ok("pace.log, frames that each take their own time: ac1 near 0, q near 2", Math.Abs(num(own, "ac1")) < 0.1 && num(own, "q") < 2.6, own);
        Ok("pace.log: 10 slices, under 30 frames nothing", held.Split(new[] { "slices " }, StringSplitOptions.None)[1].Split(' ')[0].Split(',').Length == 10 && Frames.PaceText(new List<long> { 1, 2, 3 }, F) == null);

        // ---- sessions from before 2.0.1, re-estimated (2.1) ----
        int mv; string ln, o;
        // uncapped: capped seconds every minute, the fps going up and down
        ln = Sess(Old, Mins(30, i => new[] { 0, 10, 50 }), Fps(30, i => 250 + (i * 37 % 200)));
        o = Games.Reestimate(ln, out mv); var dd = D(o);
        Ok("uncapped before 2.0.1: its capped seconds are CPU bound", mv == 1500 && I(dd, "f") == 0 && I(dd, "c") == 1800 && I(dd, "g") == 0 && I(dd, "est") == 1500, "moved " + mv + ", g/c/f " + I(dd, "g") + "/" + I(dd, "c") + "/" + I(dd, "f"));
        Ok("its minutes too: [0, 60, 0] each, the timeline letters c", ((object[])dd["tc"]).All(m => js.Serialize(m) == "[0,60,0]") && (string)dd["tb"] == new string('c', 30), (string)dd["tb"]);
        var a0 = D(ln);
        Ok("everything else in the line stays as it was", a0.Keys.Where(k => !new[] { "f", "c", "tc", "tb" }.Contains(k)).All(k => js.Serialize(a0[k]) == js.Serialize(dd[k])) && dd.Keys.Count == a0.Keys.Count + 1);
        Ok("re-estimated once: a second time changes nothing", Games.Reestimate(o, out mv) == o && mv == 0);
        // capped: the fps held at 237 (a cap for 240 Hz), within a frame or so
        ln = Sess(Old, Mins(30, i => new[] { 0, 5, 55 }), Fps(30, i => 236 + i % 3));
        Ok("capped before 2.0.1 (fps held at 236 to 238): the line as it was", Games.Reestimate(ln, out mv) == ln && mv == 0);
        // both: 20 minutes held at 237, 10 that go up and down
        ln = Sess(Old, Mins(30, i => i < 20 ? new[] { 0, 5, 55 } : new[] { 5, 15, 40 }), Fps(30, i => i < 20 ? 237 : 300 + i * 13));
        o = Games.Reestimate(ln, out mv); dd = D(o);
        Ok("held minutes stay capped, the others go to CPU bound", mv == 400 && I(dd, "f") == 20 * 55 && I(dd, "c") == 20 * 5 + 10 * 55 && I(dd, "g") == 50, "moved " + mv + ", g/c/f " + I(dd, "g") + "/" + I(dd, "c") + "/" + I(dd, "f"));
        Ok("their letters: f for the held, c for the rest", (string)dd["tb"] == new string('f', 20) + new string('c', 10), (string)dd["tb"]);
        // a cap of a few minutes (a menu at 120) in a GPU-bound session: under 5 minutes is no plateau
        ln = Sess(Old, Mins(20, i => i < 3 ? new[] { 0, 2, 58 } : new[] { 60, 0, 0 }), Fps(20, i => i < 3 ? 120 : 160 + i));
        o = Games.Reestimate(ln, out mv); dd = D(o);
        Ok("3 capped minutes are no plateau: CPU bound, the GPU-bound minutes as they were", mv == 174 && I(dd, "f") == 0 && I(dd, "g") == 17 * 60 && ((string)dd["tb"]).StartsWith("cccg"), "moved " + mv + " " + dd["tb"]);
        // minutes without an fps (no frame count): 2.0.1 can't see a cap there
        ln = Sess(Old, Mins(10, i => new[] { 0, 0, 60 }), Fps(10, i => null));
        Ok("capped minutes without an fps: CPU bound", Games.Reestimate(ln, out mv) != ln && mv == 600);
        // a minute the app missed (null) and a timeline gap stay as they were
        ln = Sess(Old, Mins(8, i => i == 3 ? null : new[] { 0, 10, 50 }), Fps(8, i => i == 3 ? (double?)null : 200 + i * 30));
        o = Games.Reestimate(ln, out mv); dd = D(o);
        Ok("a missed minute stays empty", ((object[])dd["tc"])[3] == null && ((string)dd["tb"])[3] == '-' && mv == 350, dd["tb"] + " moved " + mv);
        // left alone: after 2.0.1, a line that says its rule, one done already, no minutes, not a session
        ln = Sess(New, Mins(10, i => new[] { 0, 0, 60 }), Fps(10, i => 200 + i * 20));
        Ok("a session that started after 2.0.1 came out: as it was", Games.Reestimate(ln, out mv) == ln && mv == 0);
        ln = Sess(Old, Mins(10, i => new[] { 0, 0, 60 }), Fps(10, i => 200 + i * 20), "\"bv\":2");
        Ok("a line that says its rule (bv): as it was", Games.Reestimate(ln, out mv) == ln && mv == 0);
        ln = Sess(Old, Mins(10, i => new[] { 0, 0, 60 }), Fps(10, i => 200 + i * 20), "\"est\":0");
        Ok("a line re-estimated already: as it was", Games.Reestimate(ln, out mv) == ln && mv == 0);
        var noMin = js.Serialize(new Dictionary<string, object> { { "game", "Old" }, { "start", Old }, { "end", Old + 600 }, { "g", 0 }, { "c", 10 }, { "f", 500 } });
        Ok("a line from before the minutes were kept (no tc): as it was", Games.Reestimate(noMin, out mv) == noMin && mv == 0);
        Ok("not a session (an old note, nonsense, nothing): as it was", Games.Reestimate("# a note", out mv) == "# a note" && Games.Reestimate("{bad", out mv) == "{bad" && Games.Reestimate("", out mv) == "" && Games.Reestimate(null, out mv) == null);
        // totals that don't add up with the minutes (an edited line): capped never goes under 0
        ln = Sess(Old, Mins(10, i => new[] { 0, 0, 60 }), Fps(10, i => 200 + i * 20)).Replace("\"f\":600", "\"f\":100");
        o = Games.Reestimate(ln, out mv); dd = D(o);
        Ok("capped never goes under 0", I(dd, "f") == 0 && I(dd, "c") == 100 && mv == 100, "f " + I(dd, "f") + " c " + I(dd, "c"));
        // the file: once, a copy as it was beside it first
        string dir = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "hwdeck-reest-" + Environment.TickCount), p = System.IO.Path.Combine(dir, "games.log");
        System.IO.Directory.CreateDirectory(dir);
        try
        {
            string l1 = Sess(Old, Mins(30, i => new[] { 0, 10, 50 }), Fps(30, i => 250 + (i * 37 % 200))), l2 = Sess(Old + 7200, Mins(30, i => new[] { 0, 5, 55 }), Fps(30, i => 237)), l3 = Sess(New, Mins(5, i => new[] { 0, 0, 60 }), Fps(5, i => 300 + i * 40)).Replace("Test game", "A newer game");   // (another game: its caps teach the old ones nothing)
            System.IO.File.WriteAllText(p, l1 + "\r\n" + l2 + "\r\n" + l3 + "\r\n");
            var logged = new List<string>();
            Games.ReestimateFiles(new[] { p }, new object(), logged.Add);
            var after = System.IO.File.ReadAllLines(p);
            Ok("the file: the old uncapped session re-estimated, the capped one and the new one as they were", after.Length == 3 && after[0] == Games.Reestimate(l1, out mv) && after[1] == l2 && after[2] == l3);
            Ok("the file: a copy as it was beside it, and one line in app.log", System.IO.File.ReadAllText(p + ".before-2.1") == l1 + "\r\n" + l2 + "\r\n" + l3 + "\r\n" && logged.Count == 1 && logged[0].Contains("1 session from before 2.0.1 re-estimated (1500 s"), logged.Count > 0 ? logged[0] : "nothing logged");
            System.IO.File.AppendAllText(p, l1.Replace("\"start\":" + Old, "\"start\":" + (Old + 100)) + "\r\n");   // (one more old one: the copy isn't written over)
            Games.ReestimateFiles(new[] { p }, new object(), logged.Add);
            Ok("the next start: only what's new is done, the first copy kept", System.IO.File.ReadAllText(p + ".before-2.1") == l1 + "\r\n" + l2 + "\r\n" + l3 + "\r\n" && System.IO.File.ReadAllLines(p).Count(x => x.Contains("\"est\":")) == 2 && logged.Count == 2);
            Games.ReestimateFiles(new[] { p }, new object(), logged.Add);
            Ok("then nothing to do: the file and app.log as they were", logged.Count == 2);
            Games.ReestimateFiles(new[] { System.IO.Path.Combine(dir, "none.log") }, new object(), logged.Add);
            Ok("no file: nothing", logged.Count == 2 && !System.IO.File.Exists(System.IO.Path.Combine(dir, "none.log")));
        }
        finally { try { System.IO.Directory.Delete(dir, true); } catch { } }
        // caps learned across a game's sessions, in the log and its bin together
        dir = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "hwdeck-reest2-" + Environment.TickCount); p = System.IO.Path.Combine(dir, "games.log");
        System.IO.Directory.CreateDirectory(dir);
        try
        {
            string longCap = Sess(Old, Mins(30, i => new[] { 0, 5, 55 }), Fps(30, i => 237)), shortCap = Sess(Old + 9000, Mins(3, i => new[] { 0, 2, 58 }), Fps(3, i => 236 + i)),
                   other = Sess(Old + 20000, Mins(3, i => new[] { 0, 2, 58 }), Fps(3, i => 237)).Replace("Test game", "Other game"),
                   menu = Sess(Old + 30000, Mins(3, i => new[] { 0, 2, 58 }), Fps(3, i => 120)), newMenu = Sess(New, Mins(4, i => new[] { 20, 0, 40 }), Fps(4, i => 119)),
                   loose = Sess(Old + 40000, Mins(3, i => new[] { 0, 2, 58 }), Fps(3, i => 150 + i * 15));
            System.IO.File.WriteAllText(p, shortCap + "\r\n" + other + "\r\n" + menu + "\r\n" + newMenu + "\r\n" + loose + "\r\n");
            System.IO.File.WriteAllText(p + ".bak", longCap + "\r\n");   // (the long capped session in the bin)
            var logged = new List<string>();
            Games.ReestimateFiles(new[] { p, p + ".bak" }, new object(), logged.Add);
            var after = System.IO.File.ReadAllLines(p);
            Ok("a short session at the cap the game showed in the bin: capped", after[0] == shortCap, after[0].Contains("\"est\":") ? "re-estimated" : "kept");
            Ok("another game at that fps learns nothing from it: CPU bound", after[1].Contains("\"est\":174"));
            Ok("a short one at a cap 2.0.1 saw (a menu at 119 to 120): capped", after[2] == menu);
            Ok("a short one with no cap seen anywhere: CPU bound", after[4].Contains("\"est\":174") && after[3] == newMenu);
            Ok("a long uncapped session passing through the game's cap: by its own plateau, CPU bound", Games.Reestimate(Sess(Old + 50000, Mins(20, i => new[] { 0, 10, 50 }), Fps(20, i => i % 5 == 0 ? 237 : 300 + i * 9)), out mv, new Dictionary<string, List<double>> { { "Test game", new List<double> { 237 } } }) != null && mv == 1000, "moved " + mv);
            Ok("the bin's capped session as it was, and no copy of the bin", System.IO.File.ReadAllText(p + ".bak") == longCap + "\r\n" && !System.IO.File.Exists(p + ".bak.before-2.1") && System.IO.File.Exists(p + ".before-2.1"));
        }
        finally { try { System.IO.Directory.Delete(dir, true); } catch { } }

        // the cutoff: when this data folder first ran 2.0.1 or 2.0.2 (its app.log), else now
        dir = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "hwdeck-reest3-" + Environment.TickCount); System.IO.Directory.CreateDirectory(dir);
        try
        {
            string al = System.IO.Path.Combine(dir, "app.log");
            Func<string, long> at = x => DateTimeOffset.Parse(x, System.Globalization.CultureInfo.InvariantCulture).ToUnixTimeSeconds();
            System.IO.File.WriteAllText(al, "2026-11-02 21:53:02+00:00  start 2.0.0 (pid 1, data x)\r\n2026-11-03 21:00:00+00:00  start 2.0.10 (pid 2, data x)\r\n2026-11-03 21:30:00+00:00  window opens 100x100 at 0,0\r\n2026-11-03 21:49:14+00:00  start 2.0.1 (pid 3, data x)\r\n2026-11-04 01:00:00+00:00  start 2.0.2 (pid 4, data x)\r\n");
            Ok("the cutoff: the first start of 2.0.1 or 2.0.2 in app.log (not 2.0.10)", Games.PaceStartIn(al) == at("2026-11-03 21:49:14+00:00"), Games.PaceStartIn(al).ToString());
            System.IO.File.WriteAllText(al, "2026-11-03 18:00:00+01:00  start 2.0.1 (pid 3, data x)\r\n");
            Ok("a 2.0.1 start before it came out (a build of his own): from when it came out", Games.PaceStartIn(al) == Games.PaceRuleSince);
            System.IO.File.WriteAllText(al, "2026-11-02 21:53:02+00:00  start 2.0.0 (pid 1, data x)\r\n");
            long now0 = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
            Ok("never ran 2.0.1 or 2.0.2: now", Math.Abs(Games.PaceStartIn(al) - now0) <= 5 && Math.Abs(Games.PaceStartIn(System.IO.Path.Combine(dir, "none.log")) - now0) <= 5);
            // a session played on an older version after 2.0.1 came out: old by this folder's cutoff
            string late = Sess(Games.PaceRuleSince + 2 * 86400, Mins(10, i => new[] { 0, 10, 50 }), Fps(10, i => 200 + i * 20));
            Ok("played on an older version after 2.0.1 came out: re-estimated by the folder's cutoff", Games.Reestimate(late, out mv) == late && Games.Reestimate(late, out mv, null, Games.PaceRuleSince + 3 * 86400) != late && mv == 500);
            // a file another program holds: false (tried again at the next start), nothing written
            p = System.IO.Path.Combine(dir, "games.log"); System.IO.File.WriteAllText(p, Sess(Old, Mins(10, i => new[] { 0, 10, 50 }), Fps(10, i => 200 + i * 20)) + "\r\n");
            var lg = new List<string>(); bool okRun;
            using (new System.IO.FileStream(p, System.IO.FileMode.Open, System.IO.FileAccess.Read, System.IO.FileShare.None)) okRun = Games.ReestimateFiles(new[] { p }, new object(), lg.Add);
            Ok("a file held by another program: false, nothing written, said in app.log", !okRun && !System.IO.File.Exists(p + ".before-2.1") && lg.Count == 1 && lg[0].Contains("tried again at the next start"), lg.Count > 0 ? lg[0] : "");
            Ok("then free: true, done", Games.ReestimateFiles(new[] { p }, new object(), lg.Add) && System.IO.File.Exists(p + ".before-2.1"));
            Ok("nothing to do, or no file: true", Games.ReestimateFiles(new[] { p, System.IO.Path.Combine(dir, "none.log") }, new object(), lg.Add));
        }
        finally { try { System.IO.Directory.Delete(dir, true); } catch { } }

        // ---- 2.1: the last game session, for the Game cells while no game runs ----
        {
            long now = 1800000000;
            Func<string, long, long, int, string, string> line = (g, st, en, secs, extra) => "{\"game\":\"" + g + "\",\"start\":" + st + ",\"end\":" + en + ",\"from\":" + st + ",\"secs\":" + secs + ",\"front\":" + secs + ",\"fps\":351,\"low\":183,\"items\":[[\"CPU temp\",\"C\",57,65,85,92,1,null,0,\"k\",0]],\"g\":1191,\"c\":4620,\"f\":178,\"tf\":[322,null,399],\"tl\":[78,null,214],\"tb\":\"cc-g\"" + extra + "}";
            string log = line("Old", now - 200000, now - 199000, 1000, "") + "\r\n" +
                         line("Deadlock", now - 13000 - 6364, now - 13000, 6364, "") + "\r\n" +
                         line("Mine", now - 900, now - 100, 800, ",\"custom\":1") + "\r\n" +           // your own session: not play
                         line("Earlier", now - 90000, now - 80000, 10000, "") + "\r\n" +                // written later, ended earlier
                         "not a session line\r\n" + "{\"game\":\"Cut\",\"start\":" + (now - 50) + ",\"end\":";   // (a line being written)
            var L = Games.LastOf(log, now);
            Ok("the last session is the one that ended last, your own sessions and a half line left out", L != null && (string)L["game"] == "Deadlock" && Convert.ToInt64(L["end"]) == now - 13000, L == null ? "null" : (string)L["game"]);
            Ok("with its averages, its seconds per call and its minutes", L != null && Convert.ToInt32(L["fps"]) == 351 && Convert.ToInt32(L["low"]) == 183 && Convert.ToInt32(L["c"]) == 4620 && (string)L["tb"] == "cc-g" && ((System.Collections.ArrayList)L["tf"]).Count == 3 && ((System.Collections.ArrayList)L["tf"])[1] == null);
            var day = L == null ? null : (List<object>)L["day"];
            Ok("the last 24 h: the sessions that ended in them, as start, end and seconds", day != null && day.Count == 2 && day.Cast<object[]>().Any(d => Convert.ToInt64(d[1]) == now - 13000 && Convert.ToInt32(d[2]) == 6364) && day.Cast<object[]>().Any(d => Convert.ToInt64(d[1]) == now - 80000), day == null ? "" : day.Count.ToString());
            Ok("its items aren't sent (only what the cells show)", L != null && !L.ContainsKey("items") && !L.ContainsKey("tc"));
            Ok("no sessions, or only your own: null", Games.LastOf("", now) == null && Games.LastOf(null, now) == null && Games.LastOf(line("Mine", now - 900, now - 100, 800, ",\"custom\":1"), now) == null);
            Ok("a line whose end isn't after its start: left out", Games.LastOf(line("Bad", now - 100, now - 100, 0, ""), now) == null);
            var cut = Games.LastOf(log + "\r\n{\"game\":\"Cut\",\"start\":" + (now - 60) + ",\"end\":" + (now - 5) + ",\"from\":" + (now - 60) + ",\"items\":[[\"CPU", now);
            Ok("the last line cut by a crash after its end: the session that ended before it", cut != null && (string)cut["game"] == "Deadlock", cut == null ? "null" : (string)cut["game"]);
        }

        // ---- 2.1: the history journal (every 15 min only what closed since; hist.bin whole once a day and at exit) ----
        {
            string hd = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "hwdeck-hist-" + Environment.TickCount); System.IO.Directory.CreateDirectory(hd);
            string jp = System.IO.Path.Combine(hd, "hist.jrn"), bp = System.IO.Path.Combine(hd, "hist.bin");
            Action<History> wait = x => { for (int i = 0; i < 200 && x.Busy; i++) System.Threading.Thread.Sleep(10); };
            try
            {
                int m0 = (int)(Source.Unix() / 60);
                var h = new History(hd); h.TestFrom(m0 - 10);
                h.TestMinute("k.a", m0 - 5, 1.5f, 2f);
                bool w1 = h.Journal(); wait(h);
                h.TestMinute("k.b", m0 - 2, 7f, 8f);
                bool w2 = h.Journal(); wait(h);
                bool none = !h.Journal();
                Ok("a journal write per 15 min, only what is new each time (nothing new: nothing written)", w1 && w2 && none && System.IO.File.Exists(jp) && !System.IO.File.Exists(bp), new System.IO.FileInfo(jp).Length + " B");
                var h2 = new History(hd);
                Ok("a start reads the journal's chunks (no hist.bin yet)", h2.TestRead("k.a", m0 - 5) == 1.5f && h2.TestRead("k.b", m0 - 2) == 7f && h2.HadJournal, h2.TestRead("k.a", m0 - 5) + " / " + h2.TestRead("k.b", m0 - 2));
                using (var f = new System.IO.FileStream(jp, System.IO.FileMode.Append)) { var torn = new byte[] { 0x4A, 0x52, 0x4E, 0x31, 0xFF, 0xFF, 0, 0, 1, 2, 3 }; f.Write(torn, 0, torn.Length); }
                var h3 = new History(hd);
                Ok("a chunk cut short by a crash is left out, the ones before it count", h3.TestRead("k.a", m0 - 5) == 1.5f && h3.TestRead("k.b", m0 - 2) == 7f);
                h3.Save(true);
                var h4 = new History(hd);
                Ok("a whole save: hist.bin has it all, the journal goes", System.IO.File.Exists(bp) && !System.IO.File.Exists(jp) && h4.TestRead("k.a", m0 - 5) == 1.5f && h4.TestRead("k.b", m0 - 2) == 7f && !h4.HadJournal);
            }
            finally { try { System.IO.Directory.Delete(hd, true); } catch { } }
        }

        Console.WriteLine("\n" + (runs - fails) + "/" + runs + " passed");
        Console.WriteLine(fails == 0 ? "ALL PASS" : "SOME FAILED");
        return fails == 0 ? 0 : 1;
    }
    // frame generation: a real frame each 1/fps, a made-up one gap ms after it
    static List<long> Pairs(double fps, double gapMs, double secs)
    {
        var ts = new List<long>(); long end = 1000 * F; double step = F / fps;
        for (double k = 0; k * step <= secs * F; k++) { long t = end - (long)(k * step); ts.Add(t); ts.Add(t - (long)(step - gapMs * F / 1000)); }
        ts.Sort(); return ts;
    }
    // HWiNFO's two readings the call goes by, by their names
    class Fake : Source
    {
        public Fake()
        {
            Sensors.Add(new Sensor { Key = "s.0", Name = "GPU [#0]: Test" }); Sensors.Add(new Sensor { Key = "s.1", Name = "CPU [#0]: Test" });
            Readings.Add(new Reading { Key = "s.0/1", Label = "GPU Core Load", Unit = "%", Sensor = 0, Type = 7 });
            Readings.Add(new Reading { Key = "s.1/1", Label = "Max CPU/Thread Usage", Unit = "%", Sensor = 1, Type = 7 });
            Size(2); Status = "ok"; Version = 1;
        }
        public int Set(double gpu, double cpu) { Values[0] = gpu; Values[1] = cpu; Status = "ok"; return 0; }
        public override void Poll() { }
    }
}
