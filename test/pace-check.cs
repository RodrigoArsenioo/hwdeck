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

    static int Main()
    {
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

        // ---- pace.log's numbers (to tune Pace from real games later) ----
        string held = Frames.PaceText(Deadline(240, 0.3, 6), F), own = Frames.PaceText(Relative(240, 0.3, 0, 1, 6), F);
        Func<string, string, double> num = (line, k) => { var a = line.Split(new[] { "  " }, StringSplitOptions.None).First(x => x.StartsWith(k + " ")); return double.Parse(a.Substring(k.Length + 1), System.Globalization.CultureInfo.InvariantCulture); };
        Ok("pace.log, frames held to a clock: fps 240, ac1 near -0.5, q near 4", Math.Abs(num(held, "fps") - 240) < 1 && num(held, "ac1") < -0.35 && num(held, "q") > 3, held);
        Ok("pace.log, frames that each take their own time: ac1 near 0, q near 2", Math.Abs(num(own, "ac1")) < 0.1 && num(own, "q") < 2.6, own);
        Ok("pace.log: 10 slices, under 30 frames nothing", held.Split(new[] { "slices " }, StringSplitOptions.None)[1].Split(' ')[0].Split(',').Length == 10 && Frames.PaceText(new List<long> { 1, 2, 3 }, F) == null);
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
