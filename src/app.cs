// HW Deck: a dashboard for whatever HWiNFO measures. The host reads HWiNFO's shared memory, keeps history, logs
// warnings and game sessions, and stores files; the page (web\index.html in WebView2) owns the layout. Every
// reading has a key that survives restarts and renames: sensor id.instance/reading id, e.g. f0000501.0/01000000.
//   HWDeck.exe            normal start
//   HWDeck.exe -min       start in the tray
//   --fake [N]            a made-up machine with N readings instead of HWiNFO (tests, demos)
//   --data <dir>          keep layouts, slots, logs and history in <dir> instead of %APPDATA%\HW Deck
//   --install-setup, --hwinfo-task, --admin-task ...   the admin work: the installer's, the HWiNFO task's, Settings' (see Elevated)
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.MemoryMappedFiles;
using System.Linq;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using HwHeadset;   // (the headset, at the end of this file)

[assembly: System.Reflection.AssemblyTitle("HW Deck")]
[assembly: System.Reflection.AssemblyProduct("HW Deck")]
[assembly: System.Reflection.AssemblyDescription("A dashboard for whatever HWiNFO measures")]
[assembly: System.Reflection.AssemblyCopyright("MIT License")]
[assembly: System.Reflection.AssemblyVersion(AppInfo.Version + ".0")]       // (from the one version below: 2.1.1's exe
[assembly: System.Reflection.AssemblyFileVersion(AppInfo.Version + ".0")]   // said 2.1.0.0, these were bumped by hand)
[assembly: System.Reflection.AssemblyInformationalVersion(AppInfo.Version)]

static class AppInfo
{
    public const string Version = "2.6.3";
    // the version this copy runs as: this one; a made-up copy (--fake) can run as another with HWDECK_RUNVER (the update
    // notes' test, 11-07: an install going from one version to the next on one data folder)
    public static string Run = Version;
    // log timestamps in one fixed form whatever the PC's region (its time separator or calendar would break the page's
    // parsing), with the UTC offset so durations stay right across a summer time change
    public static string Stamp() { return DateTime.Now.ToString("yyyy-MM-dd HH:mm:sszzz", System.Globalization.CultureInfo.InvariantCulture); }
}

// the logs and the files written whole. Swap: a temp file on the disk (flushed) before it replaces the old one, so a
// power cut leaves the old file or the new one, never an empty one. Append: lines at the end; a write that fails half
// way (a full disk) is cut back off, so the next try starts on a clean line
static class Disk
{
    static readonly Encoding Utf8 = new UTF8Encoding(false);
    public static void Swap(string path, string text)
    {
        string tmp = path + ".tmp";
        var b = Utf8.GetBytes(text);
        using (var fs = new FileStream(tmp, FileMode.Create, FileAccess.Write, FileShare.None)) { fs.Write(b, 0, b.Length); fs.Flush(true); }
        if (File.Exists(path)) File.Replace(tmp, path, null); else File.Move(tmp, path);
    }
    public static void SwapLines(string path, IEnumerable<string> lines) { Swap(path, string.Concat(lines.Select(l => l + "\r\n"))); }
    public static void Append(string path, string text)
    {
        using (var fs = new FileStream(path, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.ReadWrite | FileShare.Delete, 1))   // (unbuffered: nothing left to write after a cut)
        {
            long at = fs.Seek(0, SeekOrigin.End);
            // a last line cut short (power lost or a blue screen right after a write) ends here first, so the new
            // text isn't glued to it and lost with it
            if (at > 0) { fs.Seek(at - 1, SeekOrigin.Begin); int e = fs.ReadByte(); if (e == '\r') text = "\n" + text; else if (e != '\n') text = "\r\n" + text; fs.Seek(at, SeekOrigin.Begin); }
            var b = Utf8.GetBytes(text);
            try { fs.Write(b, 0, b.Length); }
            catch { try { fs.SetLength(at); } catch { } throw; }
        }
    }
    public static void AppendLines(string path, IEnumerable<string> lines) { Append(path, string.Concat(lines.Select(l => l + "\r\n"))); }
}

class Sensor { public string Key, Name; }
class Reading { public string Key, Label, Unit, Orig, Kind; public int Sensor, Type; }   // Type: HWiNFO's, 1 temp .. 8 other; Kind: see Extra

// what this build calls itself and where it keeps its things. A build with extras (see Extra) may change these in
// its own Brand.Custom; HW Deck itself has none, so the call compiles away
static partial class Brand
{
    public static string Name = "HW Deck";      // the window, the tray, messages, the Start with Windows entry
    public static string DataDir = null;        // the data folder when no --data is given (null: %APPDATA%\<Name>)
    public static bool Updates = true;          // asks GitHub once a day for a new HW Deck
    public static bool NoActions = false;       // a copy that shows everything but changes nothing on the PC (a build's test copy)
    static partial void Custom();
    static Brand() { Custom(); }
}

// readings from somewhere else than HWiNFO, which a build with extras adds (HW Deck itself has none): one group, shown
// as a sensor in Storage, with its readings after HWiNFO's. Values follows Readings (NaN: no value); bump Version
// whenever the readings themselves change. A reading with a Kind is drawn by the build's web\extras.js
abstract class Extra
{
    public string Key = "", Name = "";                              // the group: "x.screens", "Screens"
    public readonly List<Reading> Readings = new List<Reading>();    // their Key: the group's Key + "/" + an id of its own
    public double[] Values = new double[0];
    public int Version = 0;
    public virtual void Poll() { }                                  // every tick, four times a second: keep it cheap
    public virtual void Second() { }                                // once a second, before the history takes its sample
}

// the readings and their latest values; Min, Max and Avg are HWiNFO's own (since it started or was reset)
abstract class Source
{
    public string Status = "missing";      // ok | stale | missing
    public long Age;                        // seconds since HWiNFO last polled
    public List<Sensor> Sensors = new List<Sensor>();
    public List<Reading> Readings = new List<Reading>();
    public double[] Values = new double[0], Min = new double[0], Max = new double[0], Avg = new double[0];
    public int Version;                     // bumps whenever the catalog (which readings, their names) changes
    public string PmProc;                   // the process HWiNFO's PresentMon sensor follows right now (null: none)
    public Action<string> Note = delegate { };   // (for the app's log: a catalog that changed, see HwSource)
    public abstract void Poll();
    public static long Unix() { return DateTimeOffset.UtcNow.ToUnixTimeSeconds(); }
    protected void Size(int n)
    {
        if (Values.Length == n) return;
        Values = new double[n]; Min = new double[n]; Max = new double[n]; Avg = new double[n];
    }
}

// HWiNFO's shared memory (Settings > Shared Memory Support). Opened fresh on every poll, like the tailored
// app: holding the mapping would keep a dead HWiNFO's last values alive
class HwSource : Source
{
    const uint SIG = 0x53695748;            // "HWiS"
    public static string MapName = "Global\\HWiNFO_SENS_SM2";   // (a --hwtest copy reads fakehw's block instead, see Main, 11-17)
    byte[] sbuf = new byte[0], rbuf = new byte[0];
    ulong idHash; long namesAt;
    bool shortHeld;   // (the last poll found fewer readings than the catalog has and kept what it had: see Poll)
    static readonly Encoding Ansi = Encoding.GetEncoding(1252);
    static double Fin(double v) { return double.IsInfinity(v) ? double.NaN : v; }

    public override void Poll()
    {
        try
        {
            using (var mmf = MemoryMappedFile.OpenExisting(MapName, MemoryMappedFileRights.Read))
            using (var acc = mmf.CreateViewAccessor(0, 0, MemoryMappedFileAccess.Read))
            {
                if (acc.ReadUInt32(0) != SIG) { Status = "missing"; shortHeld = false; return; }   // "DEAD" once HWiNFO shuts it
                long poll = acc.ReadInt64(12);
                uint sOfs = acc.ReadUInt32(20), sSize = acc.ReadUInt32(24), sCount = acc.ReadUInt32(28);
                uint rOfs = acc.ReadUInt32(32), rSize = acc.ReadUInt32(36), rCount = acc.ReadUInt32(40);
                if (sSize < 264 || rSize < 316 || sSize > 8192 || rSize > 8192 || sCount > 100000 || rCount > 200000) { Status = "missing"; shortHeld = false; return; }
                long sLen = (long)sSize * sCount, rLen = (long)rSize * rCount;
                // a header that promises more than the mapping holds is a half-written or foreign block, not readings
                if (sOfs + sLen > acc.Capacity || rOfs + rLen > acc.Capacity) { Status = "missing"; shortHeld = false; return; }
                // (HWiNFO fills its reading list again in place now and then, and for a few ms its header counts
                // fewer readings than there are: 232, 177, 232 inside 50 ms, seen 11-11. A poll that landed there
                // made a catalog of the short list, and the cells of the readings missing from it said "not available
                // now" for a second. So a count that went down is not taken by the poll that first finds it: that poll
                // keeps what the last one read, and the next takes whatever is there. One poll, never more: a list
                // that truly got shorter is a second late, and nothing stays held (the review 11-11: held until a
                // count came twice, a list coming back in steps kept the old one). A list that grew is taken at once)
                if (Readings.Count > 0 && rCount < Readings.Count && !shortHeld)
                {
                    shortHeld = true;
                    Note("catalog: HWiNFO counted " + rCount + " readings for a moment (" + Readings.Count + " before): kept as it was, the next poll decides");
                    return;
                }
                shortHeld = false;
                if (sbuf.Length != sLen) sbuf = new byte[sLen];
                if (rbuf.Length != rLen) rbuf = new byte[rLen];
                acc.ReadArray(sOfs, sbuf, 0, (int)sLen);
                acc.ReadArray(rOfs, rbuf, 0, (int)rLen);
                // HWiNFO's own polling period (newer versions write it after the header): a long one isn't a stall
                long period = sOfs >= 48 && rOfs >= 48 ? acc.ReadUInt32(44) : 0;

                // which sensors and readings exist, by id: a change means a new catalog; names are re-read every
                // 30 s too (a rename in HWiNFO changes no id)
                ulong h = 14695981039346656037UL;
                for (int i = 0; i < sCount; i++) { h = Fnv(h, BitConverter.ToUInt32(sbuf, i * (int)sSize)); h = Fnv(h, BitConverter.ToUInt32(sbuf, i * (int)sSize + 4)); }
                for (int i = 0; i < rCount; i++) { int o = i * (int)rSize; h = Fnv(h, BitConverter.ToUInt32(rbuf, o)); h = Fnv(h, BitConverter.ToUInt32(rbuf, o + 4)); h = Fnv(h, BitConverter.ToUInt32(rbuf, o + 8)); }
                long now = Unix();
                if (h != idHash || Readings.Count != rCount || now - namesAt >= 30)
                {
                    idHash = h; namesAt = now;
                    BuildCatalog((int)sSize, (int)sCount, (int)rSize, (int)rCount);
                }
                Size((int)rCount);
                for (int i = 0; i < rCount; i++)
                {
                    int o = i * (int)rSize;
                    // (an infinite value, a division by zero in a custom sensor or a PresentMon reading with no frames, is
                    // no reading: kept, it would turn the page's messages and a game's report line into text that
                    // isn't JSON)
                    Values[i] = Fin(BitConverter.ToDouble(rbuf, o + 284)); Min[i] = Fin(BitConverter.ToDouble(rbuf, o + 292));
                    Max[i] = Fin(BitConverter.ToDouble(rbuf, o + 300)); Avg[i] = Fin(BitConverter.ToDouble(rbuf, o + 308));
                }
                PmProc = null;
                if (pmSensor >= 0 && pmSensor < sCount)
                {
                    var m = Regex.Match(SensorName(pmSensor, (int)sSize), @"\[(.+)\]\s*$");
                    if (m.Success) PmProc = m.Groups[1].Value;
                }
                Age = Math.Max(0, now - poll);
                Status = Age > Math.Max(15, 3 * Math.Min(period, 600000) / 1000) ? "stale" : "ok";
            }
        }
        catch (Exception) { Status = "missing"; shortHeld = false; }
    }

    static ulong Fnv(ulong h, uint v) { for (int k = 0; k < 4; k++) { h ^= (v >> (k * 8)) & 0xff; h *= 1099511628211UL; } return h; }

    // a NUL-terminated string field; newer HWiNFO also writes UTF-8 copies (sensor element 392+ bytes, reading 460+)
    static string Str(byte[] b, int at, int len, Encoding enc)
    {
        int end = at; while (end < at + len && b[end] != 0) end++;
        return enc.GetString(b, at, end - at).Trim();
    }

    int pmSensor = -1;
    string SensorName(int i, int sSize)
    {
        int o = i * sSize;
        string name = sSize >= 392 ? Str(sbuf, o + 264, 128, Encoding.UTF8) : "";
        if (name.Length == 0) name = Str(sbuf, o + 136, 128, Ansi);
        if (name.Length == 0) name = Str(sbuf, o + 8, 128, Ansi);
        return name;
    }

    void BuildCatalog(int sSize, int sCount, int rSize, int rCount)
    {
        var sens = new List<Sensor>(sCount);
        pmSensor = -1;
        for (int i = 0; i < sCount; i++)
        {
            int o = i * sSize;
            string name = SensorName(i, sSize);
            // PresentMon is named after the process it follows ("PresentMon [game.exe]") and that changes every few
            // seconds; the catalog keeps the plain name, the process goes to PmProc on every poll
            if (name.StartsWith("PresentMon")) { if (pmSensor < 0) pmSensor = i; name = Regex.Replace(name, @"\s*\[[^\]]*\]\s*$", ""); }
            sens.Add(new Sensor { Key = BitConverter.ToUInt32(sbuf, o).ToString("x8") + "." + BitConverter.ToUInt32(sbuf, o + 4), Name = name });
        }
        var reads = new List<Reading>(rCount);
        var seen = new HashSet<string>();
        for (int i = 0; i < rCount; i++)
        {
            int o = i * rSize;
            int si = (int)BitConverter.ToUInt32(rbuf, o + 4);
            string label = rSize >= 444 ? Str(rbuf, o + 316, 128, Encoding.UTF8) : "";
            if (label.Length == 0) label = Str(rbuf, o + 140, 128, Ansi);
            string orig = Str(rbuf, o + 12, 128, Ansi);   // HWiNFO's own name; the label above may be the user's
            if (label.Length == 0) label = orig;
            string unit = rSize >= 460 ? Str(rbuf, o + 444, 16, Encoding.UTF8) : Str(rbuf, o + 268, 16, Ansi);
            bool known = si >= 0 && si < sens.Count;
            string key = (known ? sens[si].Key : "unknown.0") + "/" + BitConverter.ToUInt32(rbuf, o + 8).ToString("x8");
            if (!seen.Add(key)) key += "~" + i;   // two readings with one id would share a history; keep them apart
            reads.Add(new Reading { Key = key, Label = label, Orig = orig, Unit = unit, Sensor = known ? si : -1, Type = (int)BitConverter.ToUInt32(rbuf, o) });
        }
        if (!Same(sens, reads))
        {
            // (one line in the log per catalog that changed, the first one at the start too: how often HWiNFO's list changes)
            int was = Readings.Count, wasS = Sensors.Count;
            Sensors = sens; Readings = reads; Version++;
            Note("catalog: " + reads.Count + " readings in " + sens.Count + " sensors" + (was > 0 ? " (" + was + " in " + wasS + " before)" : ""));
        }
    }

    bool Same(List<Sensor> s, List<Reading> r)
    {
        if (s.Count != Sensors.Count || r.Count != Readings.Count) return false;
        for (int i = 0; i < s.Count; i++) if (s[i].Key != Sensors[i].Key || s[i].Name != Sensors[i].Name) return false;
        for (int i = 0; i < r.Count; i++)
            if (r[i].Key != Readings[i].Key || r[i].Label != Readings[i].Label || r[i].Unit != Readings[i].Unit || r[i].Sensor != Readings[i].Sensor) return false;
        return true;
    }
}

// a made-up machine: N readings over a few dozen sensors, values that move like a PC under a slow load cycle
class FakeSource : Source
{
    readonly double[] bases, pin;
    readonly Stopwatch clock = Stopwatch.StartNew();
    readonly Random rnd = new Random(7);
    double[] sum; int n;
    int gpuI = -1, cpuI = -1;   // what the bottleneck goes by, named as HWiNFO names them, swinging through all three calls
    int fpsI = -1, lowI = -1;   // the 1% low stays under the fps
    public FakeSource(int count)
    {
        string[][] kinds = {
            new[] { "CPU [#0]: Fake Ryzen 9 9950X: Enhanced", "f0000501" }, new[] { "dGPU [#0]: Fake GeForce RTX 5090", "e0002000" },
            new[] { "Fake Motherboard (Nuvoton NCT6799D)", "f7067010" }, new[] { "S.M.A.R.T.: Fake NVMe 2TB [C:]", "f0000100" },
            new[] { "DDR5 DIMM [#1]: Fake 32GB", "f3000005" }, new[] { "PresentMon", "f0000ff0" } };
        string[][] labels = {
            new[] { "1", "Temperature", "\u00b0C", "55" }, new[] { "2", "Voltage", "V", "1.2" }, new[] { "3", "Fan", "RPM", "1100" },
            new[] { "5", "Power", "W", "60" }, new[] { "6", "Clock", "MHz", "4800" }, new[] { "7", "Usage", "%", "35" },
            new[] { "4", "Current", "A", "8" }, new[] { "8", "Framerate", "FPS", "200" } };
        int perSensor = Math.Max(1, (int)Math.Ceiling(count / 24.0));
        int sCount = (int)Math.Ceiling(count / (double)perSensor);
        bases = new double[count];
        for (int s = 0; s < sCount; s++)
        {
            var k = kinds[s % kinds.Length];
            int copy = s / kinds.Length;
            Sensors.Add(new Sensor { Key = k[1] + "." + copy, Name = copy == 0 ? k[0] : k[0] + " #" + (copy + 1) });
        }
        for (int i = 0; i < count; i++)
        {
            int s = i / perSensor, j = i % perSensor;
            var l = labels[(j + s) % labels.Length];
            int type = int.Parse(l[0]);
            Readings.Add(new Reading { Key = Sensors[s].Key + "/" + (type << 24 | j).ToString("x8"), Label = l[1] + " " + (j + 1), Unit = l[2], Sensor = s, Type = type });
            bases[i] = double.Parse(l[3], System.Globalization.CultureInfo.InvariantCulture) * (0.8 + 0.4 * ((i * 37) % 11) / 10.0);
        }
        for (int i = 0; i < count; i++)
        {
            var r = Readings[i];
            if (r.Type != 7) continue;
            string sn = Sensors[r.Sensor].Name;
            if (cpuI < 0 && sn.StartsWith("CPU")) { cpuI = i; r.Label = "Max CPU/Thread Usage"; }
            else if (gpuI < 0 && sn.StartsWith("dGPU")) { gpuI = i; r.Label = "GPU Core Load"; }
        }
        // and what a game report picks by name: sensor, type, HWiNFO's label, a unit instead of the made-up one
        string[][] named = {
            new[] { "CPU", "1", "CPU (Tctl/Tdie)", "" }, new[] { "CPU", "5", "CPU Package Power", "" }, new[] { "CPU", "7", "Total CPU Usage", "" },
            new[] { "dGPU", "1", "GPU Temperature", "" }, new[] { "dGPU", "1", "GPU Hot Spot Temperature", "" }, new[] { "dGPU", "1", "GPU Memory Junction Temperature", "" },
            new[] { "dGPU", "5", "GPU Power", "" }, new[] { "dGPU", "6", "GPU Memory Allocated", "MB" },
            new[] { "DDR5", "6", "Physical Memory Used", "MB" }, new[] { "DDR5", "6", "Physical Memory Available", "MB" },
            new[] { "PresentMon", "8", "Framerate", "" }, new[] { "PresentMon", "8", "Framerate (1% low)", "" } };
        var taken = new HashSet<int> { cpuI, gpuI };
        foreach (var nm in named)
            for (int i = 0; i < count; i++)
            {
                var r = Readings[i];
                if (taken.Contains(i) || r.Type != int.Parse(nm[1]) || !Sensors[r.Sensor].Name.StartsWith(nm[0])) continue;
                r.Label = nm[2]; if (nm[3].Length > 0) r.Unit = nm[3];
                taken.Add(i); break;
            }
        // tests (HWDECK_FAKEPINS=1): a 12V-2x6 connector's six pins on the GPU, from made-up currents and powers there
        if (Environment.GetEnvironmentVariable("HWDECK_FAKEPINS") == "1")
            foreach (var spec in new[] { new[] { "4", "Current" }, new[] { "5", "Power" }, new[] { "2", "Voltage" } })
            {
                int k = 0;
                for (int i = 0; i < count && k < 6; i++)
                {
                    var r = Readings[i];
                    if (taken.Contains(i) || r.Type != int.Parse(spec[0]) || !Sensors[r.Sensor].Name.StartsWith("dGPU")) continue;
                    r.Label = "GPU 12VHPWR Pin" + (++k) + " " + spec[1]; taken.Add(i);
                }
            }
        // tests (HWDECK_FAKEZERO=1): fans at 0 rpm all along, one on the board (an empty header: hidden by default) and
        // one on the GPU ("GPU Fan1", stopped at idle on purpose: stays in sight)
        if (Environment.GetEnvironmentVariable("HWDECK_FAKEZERO") == "1")
            foreach (var sn in new[] { "dGPU", "Fake Motherboard" })
            {
                int i = 0;
                while (i < count && (taken.Contains(i) || Readings[i].Type != 3 || !Sensors[Readings[i].Sensor].Name.StartsWith(sn))) i++;
                if (i >= count) continue;
                bases[i] = 0; taken.Add(i);
                if (sn == "dGPU") Readings[i].Label = "GPU Fan1";
            }
        fpsI = Readings.FindIndex(r => r.Label == "Framerate"); lowI = Readings.FindIndex(r => r.Label == "Framerate (1% low)");
        Size(count); sum = new double[count]; pin = new double[count];
        for (int i = 0; i < count; i++) { Min[i] = double.MaxValue; Max[i] = double.MinValue; pin[i] = double.NaN; }
        Version = 1;
    }
    // tests: hold a reading at a value (NaN lets it go)
    public void Pin(string key, double v) { int i = Readings.FindIndex(r => r.Key == key); if (i >= 0) pin[i] = v; }
    // tests: made-up frames for the bottleneck, as if HW Deck counted the game's (fps 0: none). Without swing they are held
    // to a clock (a cap), each off its time by up to jitter (a part of the frame time, either way); with swing each takes
    // its own time off the one before (uncapped), the rate swinging by swing (a part of it) over 1.7 s
    double frFps, frJitter, frSwing;
    bool frStable;   // (its rate held for 30 s, as Frames.Stable: set by the test, off unless asked)
    public void SetFrames(double fps, double jitter, double swing, bool stable = false) { frFps = fps; frJitter = jitter; frSwing = swing; frStable = stable; }
    public bool Counted { get { return frFps > 0; } }
    public bool Stable { get { return frFps > 0 && frStable; } }
    public bool? Steady()
    {
        if (!(frFps > 0)) return null;
        long f = 10000000, now = clock.Elapsed.Ticks; var r = new Random(7); var ts = new List<long>(); double step = f / frFps;
        if (frSwing == 0) for (int k = 0; k * step < 6 * f && ts.Count < 20000; k++) ts.Add(now - (long)(k * step) + (long)(step * frJitter * (2 * r.NextDouble() - 1)));
        else
            for (long t = now; t > now - 6 * f && ts.Count < 20000; )
            {
                ts.Add(t);
                double fps = frFps * (1 + frSwing * Math.Sin(2 * Math.PI * t / (1.7 * f)));
                t -= (long)(f / fps * (1 + frJitter * (2 * r.NextDouble() - 1)));
            }
        ts.Sort();
        return global::Frames.Pace(ts, now, f);
    }
    public override void Poll()
    {
        double t = clock.Elapsed.TotalSeconds, load = 0.5 + 0.5 * Math.Sin(t / 26);
        n++;
        for (int i = 0; i < Values.Length; i++)
        {
            int type = Readings[i].Type; double b = bases[i];
            double v = type == 1 ? b * (0.82 + 0.38 * load) : type == 2 ? b + (rnd.NextDouble() - 0.5) * 0.01
                     : type == 8 ? b * (1.2 - 0.6 * load) : b * (0.5 + 1.0 * load);
            if (i == gpuI) v = 62 + 42 * Math.Sin(t / 40); else if (i == cpuI) v = 70 + 30 * Math.Sin(t / 23 + 1);
            v *= 1 + (rnd.NextDouble() - 0.5) * 0.02;
            if (i == gpuI || i == cpuI) v = Math.Max(0, Math.Min(100, v));
            if (i == lowI && fpsI >= 0 && fpsI < i) v = Values[fpsI] * (0.62 + 0.1 * rnd.NextDouble());
            if (!double.IsNaN(pin[i])) v = pin[i];
            Values[i] = v; sum[i] += v; Avg[i] = sum[i] / n;
            if (v < Min[i]) Min[i] = v;
            if (v > Max[i]) Max[i] = v;
        }
        Status = "ok"; Age = 0;
    }
}

// HWiNFO's readings (or the made-up ones) and after them the ones HW Deck works out itself, under a sensor of its
// own, so a cell, the history and the logs take them like any other. Their keys can't clash: HWiNFO's sensor ids
// are 8 hex digits
class DeckSource : Source
{
    public readonly Source Inner;
    public readonly Bottleneck Bneck = new Bottleneck();
    public readonly Connector Conn = new Connector();
    public Frames Frames;                                       // the game's own frames (null: not counted, see Frames)
    public double FakeHz = 240;                                 // (tests: the made-up screen's refresh rate)
    public const string GameTimeKey = "hwdeck.0/gtime";
    public Func<double> GameMin;                                // how long the game session has run, in minutes (NaN: no game)
    public readonly List<Extra> Extras = new List<Extra>();     // a build's own readings (see Extra), after HW Deck's
    int innerVersion = -1, extraVersion = -1, connAt = -1, framesAt = -1, gtAt = -1, netAt = -1, hsAt = -1, msAt = -1; bool framesOn, hsOn, msOn;
    int[] extraAt = new int[0];                                 // where each extra's readings start
    public DeckSource(Source inner) { Inner = inner; }
    public override void Poll()
    {
        Inner.Poll();
        foreach (var x in Extras) x.Poll();
        Status = Inner.Status; Age = Inner.Age; PmProc = Inner.PmProc;
        int ev = Extras.Count; foreach (var x in Extras) ev = ev * 31 + x.Version;
        bool fo = Frames != null && Frames.On, ho = Batt.HeadSeen, mo = Batt.MouseSeen;
        if (Inner.Version != innerVersion || ev != extraVersion || fo != framesOn || ho != hsOn || mo != msOn)
        {
            innerVersion = Inner.Version; extraVersion = ev; framesOn = fo; hsOn = ho; msOn = mo; hsAt = -1; msAt = -1;
            Sensors = new List<Sensor>(Inner.Sensors); Readings = new List<Reading>(Inner.Readings);
            extraAt = new int[Extras.Count]; connAt = -1; framesAt = -1; gtAt = -1; netAt = -1;
            Conn.Find(Inner);
            // nothing from HWiNFO yet, nothing of its own either: the page's setup steps go by an empty catalog
            if (Readings.Count > 0)
            {
                Sensors.Add(new Sensor { Key = "hwdeck.0", Name = "HW Deck" });
                Readings.Add(new Reading { Key = Bottleneck.Key, Label = "Bottleneck", Unit = "", Sensor = Sensors.Count - 1, Type = 8 });
                if (Conn.Has) { connAt = Readings.Count; Readings.Add(new Reading { Key = Connector.Key, Label = "12V-2x6 connector", Unit = "A", Kind = "12v", Sensor = Sensors.Count - 1, Type = 4 }); }
                gtAt = Readings.Count;
                Readings.Add(new Reading { Key = GameTimeKey, Label = "Game time", Unit = "min", Sensor = Sensors.Count - 1, Type = 8 });
                if (fo)
                {
                    framesAt = Readings.Count;
                    Readings.Add(new Reading { Key = Frames.FpsKey, Label = "Game framerate", Unit = "FPS", Sensor = Sensors.Count - 1, Type = 8 });
                    Readings.Add(new Reading { Key = Frames.LowKey, Label = "Game framerate (1% low)", Unit = "FPS", Sensor = Sensors.Count - 1, Type = 8 });
                    Readings.Add(new Reading { Key = Frames.FtKey, Label = "Game frame time", Unit = "ms", Sensor = Sensors.Count - 1, Type = 8 });
                }
                // (the internet: download and upload now, Net, 2.4.8)
                netAt = Readings.Count;
                Readings.Add(new Reading { Key = Net.DownKey, Label = "Download now", Unit = "Mbit/s", Kind = "net", Sensor = Sensors.Count - 1, Type = 8 });
                Readings.Add(new Reading { Key = Net.UpKey, Label = "Upload now", Unit = "Mbit/s", Sensor = Sensors.Count - 1, Type = 8 });
                // (the headset and the mouse, once found: their batteries; the headset's is the Headset cell, 11-13)
                if (ho)
                {
                    hsAt = Readings.Count;
                    Readings.Add(new Reading { Key = Batt.HeadKey, Label = "Headset battery", Unit = "%", Kind = "headset", Sensor = Sensors.Count - 1, Type = 8 });
                    Readings.Add(new Reading { Key = Batt.SpareKey, Label = "Spare headset battery", Unit = "%", Sensor = Sensors.Count - 1, Type = 8 });
                }
                if (mo) { msAt = Readings.Count; Readings.Add(new Reading { Key = Batt.MouseKey, Label = "Mouse battery", Unit = "%", Sensor = Sensors.Count - 1, Type = 8 }); }
                for (int j = 0; j < Extras.Count; j++)
                {
                    var x = Extras[j];
                    Sensors.Add(new Sensor { Key = x.Key, Name = x.Name });
                    extraAt[j] = Readings.Count;
                    foreach (var r in x.Readings) Readings.Add(new Reading { Key = r.Key, Label = r.Label, Unit = r.Unit ?? "", Kind = r.Kind, Sensor = Sensors.Count - 1, Type = r.Type });
                }
            }
            Bneck.Find(Inner);
            Version++;
        }
        int n = Inner.Readings.Count, m = Math.Min(n, Inner.Values.Length);
        Size(Readings.Count);
        Array.Copy(Inner.Values, Values, m); Array.Copy(Inner.Min, Min, m); Array.Copy(Inner.Max, Max, m); Array.Copy(Inner.Avg, Avg, m);
        for (int i = m; i < Values.Length; i++) { Values[i] = Min[i] = Max[i] = Avg[i] = double.NaN; }
        if (Values.Length > n) Values[n] = Bneck.Value;
        Conn.Poll(Inner);
        if (connAt >= 0 && connAt < Values.Length) Values[connAt] = Conn.Worst;
        CopyFrames();
        CopyExtras();
    }
    void CopyFrames()
    {
        if (gtAt >= 0 && gtAt < Values.Length) Values[gtAt] = GameMin != null ? GameMin() : double.NaN;
        if (netAt >= 0 && netAt + 1 < Values.Length) { Values[netAt] = Net.Down; Values[netAt + 1] = Net.Up; }
        if (hsAt >= 0 && hsAt + 1 < Values.Length) { Values[hsAt] = Batt.HeadValue(); Values[hsAt + 1] = Batt.SpareValue(); }
        if (msAt >= 0 && msAt < Values.Length) Values[msAt] = Batt.MousePct < 0 ? double.NaN : Batt.MousePct;
        if (framesAt < 0 || framesAt + 2 >= Values.Length) return;
        Values[framesAt] = Frames.Fps; Values[framesAt + 1] = Frames.Low; Values[framesAt + 2] = Frames.Ft;
    }
    void CopyExtras()
    {
        if (Values.Length <= Inner.Readings.Count) return;      // no HWiNFO yet: no extras either
        // an extra whose readings changed since the catalog was made (in its Second): nothing until the next Poll makes the
        // catalog again, rather than its new values on the old readings
        int ev = Extras.Count; foreach (var x in Extras) ev = ev * 31 + x.Version;
        if (ev != extraVersion) { if (extraAt.Length > 0) for (int i = extraAt[0]; i < Values.Length; i++) Values[i] = double.NaN; return; }
        for (int j = 0; j < Extras.Count && j < extraAt.Length; j++)
        {
            var x = Extras[j]; var v = x.Values;
            for (int i = 0; i < x.Readings.Count && extraAt[j] + i < Values.Length; i++) Values[extraAt[j] + i] = i < v.Length ? v[i] : double.NaN;
        }
    }
    // once a second, before the history takes its sample
    // pmGame: HWiNFO's PresentMon follows the game in front (its fps are the game's); front: the game is in front
    public int BlindNote;
    public void Second(bool game, bool pmGame = false, bool front = false)
    {
        try { Net.Tick(); } catch (Exception ex) { Net.Failed(ex); }   // (the internet's rate this second, and its speed test when one is due; never the rest of the second, the review 11-12)
        foreach (var x in Extras) x.Second();   // first: the bottleneck may go by a build's own measurements
        if (Frames != null) Frames.Second();   // (and by this second's pace of the game's frames)
        var fs = Inner as FakeSource;
        if (fs != null) Bneck.Second(Inner, game, fs.Steady(), fs.Counted, fs.Stable, FakeHz, pmGame ? Bneck.PmFps(Inner) : double.NaN);
        else
        {
            // (counted: its frames come in; a Vulkan or OpenGL game in front has none)
            bool counted = Frames != null && Frames.On && Frames.Seen;
            // (a game whose frames HW Deck doesn't count: HWiNFO's fps against the screen's refresh rate, for vsync)
            bool blind = game && !counted && pmGame;
            Bneck.Second(Inner, game, Frames != null ? Frames.Steady : null, counted, Frames != null && Frames.Stable, blind ? Display.FrontHz() : double.NaN, blind ? Bneck.PmFps(Inner) : double.NaN);
        }
        // (the page: in front and not counted, vsync can show when HWiNFO's fps are the game's (1), nothing can (2))
        BlindNote = !Bneck.Blind || !front ? 0 : pmGame && !double.IsNaN(Bneck.PmFps(Inner)) ? 1 : 2;
        if (Values.Length > Inner.Readings.Count) Values[Inner.Readings.Count] = Bneck.Value;
        CopyFrames();
        CopyExtras();
    }
}

// what limits the fps while a game runs, one call a second: the GPU at 95%+ is gpu-bound ('g'); under 85% the GPU
// waits: on an fps cap or vsync ('f') when the game's frames come at a held pace (Frames.Pace), else on the CPU side
// ('c'); 85-95% keeps the previous call.
// Read from HWiNFO by name: GPU core load, and Max CPU/Thread Usage (else the busiest per-thread or per-core usage)
class Bottleneck
{
    public const string Key = "hwdeck.0/bneck";
    static readonly Regex MaxRe = new Regex(@"^Max CPU/Thread Usage$"), ThreadRe = new Regex(@"^(?:[PE]-)?Core ?\d+(?: T\d+)? Usage$", RegexOptions.IgnoreCase);
    public static bool Named(Regex re, Reading r) { return re.IsMatch(r.Label) || (!string.IsNullOrEmpty(r.Orig) && re.IsMatch(r.Orig)); }
    int gpuI = -1, maxI = -1, pmI = -1; int[] threads = new int[0];
    char last = '-'; bool wasGame; int capRun;
    public double Gpu = double.NaN, Cpu = double.NaN;   // this second's inputs (for pace.log)
    public char Call = '-';                 // this second's; '-' no game, no readings or HWiNFO not sharing
    public char Live = '-';                 // the same call game or not (the cell shows it outside a game too); '-' no readings
    public double Value = double.NaN;       // this second's call for the history: 1 gpu, 2 cpu, 3 capped
    public bool Blind;                      // a game whose frames HW Deck doesn't count: no cap but vsync can be seen
    // and as three readings only the history keeps (not in the catalog): 1 for the call this second, 0 for the others
    // and with no game, so a minute's averages are the share of it each call held (the long ranges of its popup)
    public static readonly string[] ShareKeys = { Key + ".g", Key + ".c", Key + ".f" };
    public readonly double[] Shares = new double[3];
    public object[] Inputs = new object[3]; // for the page: the GPU usage key, the Max CPU/Thread Usage key, how many per-thread ones
    // a build's own measurements to go by when HWiNFO doesn't share these (see Extra): the reading's key, for the page,
    // and how to read it now (NaN: no value)
    public string OwnGpuKey = null, OwnCpuKey = null;
    public Func<double> OwnGpu = null, OwnCpu = null;
    public void Find(Source src)
    {
        gpuI = Games.GpuUsage(src); maxI = -1;
        var th = new List<int>();
        for (int i = 0; i < src.Readings.Count; i++)
        {
            var r = src.Readings[i];
            if (r.Unit != "%") continue;
            if (Named(MaxRe, r)) { if (maxI < 0) maxI = i; }
            else if (Named(ThreadRe, r)) th.Add(i);
        }
        pmI = -1;
        for (int i = 0; i < src.Readings.Count && pmI < 0; i++) { var r = src.Readings[i]; if (r.Sensor >= 0 && r.Sensor < src.Sensors.Count && src.Sensors[r.Sensor].Name.StartsWith("PresentMon") && PmFpsRe.IsMatch(r.Label)) pmI = i; }
        threads = th.ToArray();
        Inputs = new object[] { gpuI >= 0 ? src.Readings[gpuI].Key : OwnGpu != null ? OwnGpuKey : null,
                                maxI >= 0 ? src.Readings[maxI].Key : threads.Length == 0 && OwnCpu != null ? OwnCpuKey : null, threads.Length };
    }
    static double At(Source src, int i) { return i >= 0 && i < src.Values.Length && !double.IsInfinity(src.Values[i]) ? src.Values[i] : double.NaN; }
    static readonly Regex PmFpsRe = new Regex(@"^Framerate( Presented)?( \(avg\))?$");
    public double PmFps(Source src) { return At(src, pmI); }   // HWiNFO's PresentMon fps (NaN: none)
    public const int CapRun = 6;   // seconds HWiNFO's fps must stay at the screen's rate (2 or more of its polls)
    // steady: the pace of the game's frames, when HW Deck counts them (see Frames.Pace; null: not counted, or nothing to
    // tell by). Capped only when it is held: a GPU waiting while no CPU thread reads busy was called capped until 2.0.1,
    // and 11-03 Deadlock uncapped read "FPS capped" 83% of a session (GPU 63%, its busiest thread 74%, the fps anywhere
    // from 160 to 590 a minute): a game's threads wait on each other, move between cores, and none reads busy all the
    // time. HWiNFO's PresentMon fps is left out: it stays the same between its polls and can follow another app
    // counted: the game in front has its frames counted (steady null then: nothing to tell by yet, a load, back in front)
    // stable: the game's fps held within 3% for the last 30 s (a cap stays put; a CPU limit drifts with the scene)
    // hz, pm: for a game whose frames aren't counted, the screen's refresh rate and HWiNFO's fps (NaN: none)
    public void Second(Source src, bool game, bool? steady = null, bool counted = false, bool stable = false, double hz = double.NaN, double pm = double.NaN)
    {
        double gpu = At(src, gpuI), cpu = At(src, maxI);
        if (maxI < 0) foreach (int i in threads) { double v = At(src, i); if (!double.IsNaN(v) && (double.IsNaN(cpu) || v > cpu)) cpu = v; }
        if (gpuI < 0 && OwnGpu != null) gpu = OwnGpu();
        if (maxI < 0 && threads.Length == 0 && OwnCpu != null) cpu = OwnCpu();
        Gpu = gpu; Cpu = cpu;
        if (game && !wasGame) last = '-';   // (a game starting: no call carried over from the desktop)
        wasGame = game;
        char live = '-';
        if (src.Status == "ok" && !double.IsNaN(gpu) && !double.IsNaN(cpu))
        {
            // the GPU not busy: what it waits on. Held: capped, even with a thread at 80% when the rate has stayed put for 30 s
            // (2.1: a capped game with one hot thread read CPU bound; a steady CPU limit still drifts, so a busy thread with
            // a rate that moves stays CPU bound). Counted but nothing to tell by yet: the call as it was (a load, back from
            // an alt-tab). Not counted: HWiNFO's fps at the screen's refresh rate, or at the cap NVIDIA Reflex sets for it
            // (hz - hz^2/3600, from user measurements, not NVIDIA), for CapRun seconds: vsync; any other cap can't be seen,
            // so CPU bound (Blind). With no game: the desktop at the screen's pace
            double tol = Math.Max(0.01 * hz, 1);   // (a 59.94 Hz mode reports 59)
            bool atCap = !double.IsNaN(pm) && hz > 0 && (Math.Abs(pm - hz) <= tol || Math.Abs(pm - (hz - hz * hz / 3600)) <= tol);
            capRun = game && !counted && atCap ? capRun + 1 : 0;
            char waits = steady == true && (cpu < 80 || stable) ? 'f' : cpu >= 80 || steady == false ? 'c' : counted ? (last == 'c' || last == 'f' ? last : 'c') : game ? (capRun >= CapRun ? 'f' : 'c') : 'f';
            // 85 to 95%: a GPU-bound call holds on (the GPU near its top, dipping) unless the pace is held; with none before,
            // 90%+ is the GPU; else the pace decides, as under 85% (11-03 review: keeping any call let a CPU bound from the
            // 5 s before the pace was known hold a capped game at 87 to 93% all session)
            live = gpu >= 95 ? 'g' : gpu < 85 ? waits : (last == 'g' || (last == '-' && gpu >= 90)) && steady != true ? 'g' : waits;
        }
        if (live != '-') last = live;   // (a second with no value keeps the last call for the band)
        Live = live;
        Blind = game && !counted;
        char call = game ? live : '-';
        Call = call;
        // 6. each second's call as it is, the same ones the game report counts; the page shows the most common of the last 5 s
        Value = call == 'g' ? 1 : call == 'c' ? 2 : call == 'f' ? 3 : double.NaN;
        Shares[0] = call == 'g' ? 1 : 0; Shares[1] = call == 'c' ? 1 : 0; Shares[2] = call == 'f' ? 1 : 0;
    }
}

// the refresh rate of the screen the window in front is on (Hz; NaN: unknown), looked up at most every 5 s
static class Display
{
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct MONITORINFOEX { public int cbSize; public int l, t, r, b, wl, wt, wr, wb; public uint flags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dev; }
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFOEX mi);
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct DEVMODE
    {
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string name; public short specVer, drvVer, size, drvExtra; public int fields;
        public int posX, posY, orient, fixedOut; public short color, duplex, yRes, ttOpt, collate;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string form; public short logPixels; public int bits, w, h, flags, hz;
        public int icm, icmIntent, media, dither, res1, res2, panW, panH;
    }
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool EnumDisplaySettings(string dev, int mode, ref DEVMODE dm);
    static double hz = double.NaN; static int at = int.MinValue;
    public static double FrontHz()
    {
        int n = Environment.TickCount;
        if (at != int.MinValue && unchecked(n - at) < 5000) return hz;
        at = n;
        try
        {
            var mi = new MONITORINFOEX { cbSize = Marshal.SizeOf(typeof(MONITORINFOEX)) };
            var dm = new DEVMODE { size = (short)Marshal.SizeOf(typeof(DEVMODE)) };
            IntPtr m = MonitorFromWindow(GetForegroundWindow(), 2 /*MONITOR_DEFAULTTONEAREST*/);
            hz = m != IntPtr.Zero && GetMonitorInfo(m, ref mi) && EnumDisplaySettings(mi.dev, -1 /*ENUM_CURRENT_SETTINGS*/, ref dm) && dm.hz > 1 ? dm.hz : double.NaN;
        }
        catch { hz = double.NaN; }
        return hz;
    }
}

// a GPU's 12V-2x6 (12VHPWR) power connector, when HWiNFO reports its pins ("GPU 12VHPWR Pin1 Current" ... and their
// Power): its most loaded pin as a reading of HW Deck's own (a pin is rated 9.5 A; a healthy connector at a 600 W limit
// peaks near 9.1 A a pin), and whether one pin carries 1.5x its share of the load, the early sign of a bad contact
// (judged from 15 A up: at idle a spread means nothing). Its cell draws the pins (kind "12v" in deck.js)
// ---------- the internet (2.4.8; first in his dashboard 11-12, his picks for HW Deck in its mock): what the PC
// downloads and uploads this second, from Windows' own counters of the adapter the internet goes through (reading them
// sends nothing: always on), two readings under "HW Deck"; and a speed test of the line, OFF until it is turned on in
// Settings (nothing contacts a test server before that): Cloudflare's speed test (speed.cloudflare.com, the addresses
// its own page uses; its nearest site), or the nearest LibreSpeed public server when Cloudflare refuses (see Site). On
// "Test now" in the Internet cell's popup, and by itself every 8 h (or 4, 12, 24 h, or only by the button), skipped
// while a game runs or the PC already moves more than 5 Mbit/s, tried again 30 min later. A test takes about 10 s and
// at most 0.4 GB. A --fake copy plays a made-up test and sends nothing. Kept in net.json: how often, the last result,
// the list of tests ----------
static class Net
{
    public static Action<string> Log = delegate { };
    public static Action<string> Toast = delegate { };
    public static Func<bool> Gaming = () => false;
    public static Func<bool> Blocked = () => false;
    static long failLogged;
    public static void Failed(Exception ex) { long now = Source.Unix(); if (now - failLogged >= 60) { failLogged = now; Log("internet: " + ex.Message); } nic = null; Down = Up = double.NaN; }   // (logged once a minute)   // (a build's copy that must never test by itself, a test copy of it)
    public static bool On;            // the speed test's switch (settings.json "netTest", off unless turned on)
    public static bool Fake;          // a --fake copy: made-up tests, nothing sent
    public static string File_;       // net.json
    public const string DownKey = "hwdeck.0/netdown", UpKey = "hwdeck.0/netup";
    static readonly object gate = new object();

    // ---- live: the adapter's byte counters, read once a second ----
    public static double Down = double.NaN, Up = double.NaN;   // Mbit/s, this second
    public static string Link = "";                            // "Ethernet, 1 Gbit/s link"
    [DllImport("iphlpapi.dll")] static extern int GetBestInterface(uint dest, out uint index);
    static System.Net.NetworkInformation.NetworkInterface nic; static long pickedAt, inB = -1, outB = -1; static readonly Stopwatch clock = Stopwatch.StartNew(); static double lastAt, wokeAt;
    static void Pick()
    {
        string was = nic == null ? null : nic.Id;
        nic = null; Link = "";
        try
        {
            uint idx;
            if (GetBestInterface(BitConverter.ToUInt32(new byte[] { 1, 1, 1, 1 }, 0), out idx) != 0) return;   // (no route out: no internet)
            foreach (var n in System.Net.NetworkInformation.NetworkInterface.GetAllNetworkInterfaces())
            {
                try { var p = n.GetIPProperties().GetIPv4Properties(); if (p == null || p.Index != idx) continue; } catch { continue; }
                nic = n;
                double sp = 0; try { sp = n.Speed; } catch { }   // bits a second
                Link = n.Name + (sp > 0 ? ", connected at " + (sp >= 1e9 ? (sp / 1e9).ToString(sp % 1e9 == 0 ? "0" : "0.#", System.Globalization.CultureInfo.InvariantCulture) + " Gbit/s" : (sp / 1e6).ToString("0", System.Globalization.CultureInfo.InvariantCulture) + " Mbit/s") : "");   // (his 11-12 "wdym 1 Gbit/s link": the cable's or the Wi-Fi's own speed)
                break;
            }
        }
        catch { nic = null; Link = ""; }
        // (the counters start over only for another adapter: they did every 30 s, and the rate read "--" for a second,
        // the review 11-12)
        if (nic == null || nic.Id != was) inB = outB = -1;
    }
    static void Live()
    {
        if (Fake) { lock (gate) if (running) return; }   // (a made-up test: its own traffic shows, as a real test's does on the counters)
        long now = Source.Unix();
        if (nic == null || now - pickedAt >= 30) { pickedAt = now; var was = nic == null ? null : nic.Id; Pick(); if (nic != null && nic.Id != was && was != null) Log("internet: now through " + Link); }
        if (nic == null) { Down = Up = double.NaN; return; }
        long i, o;
        try { var s = nic.GetIPStatistics(); i = s.BytesReceived; o = s.BytesSent; }
        catch { nic = null; Down = Up = double.NaN; return; }
        double t = clock.Elapsed.TotalSeconds, dt = t - lastAt; lastAt = t;
        if (inB < 0 || dt <= 0.2 || dt > 5) { inB = i; outB = o; Down = Up = double.NaN; if (dt > 5) wokeAt = t; return; }   // (over 5 s since the last: a sleep in between, its average is no rate)
        Func<long, long, double> rate = (a, b) => { long d = a - b; if (d < 0) { if (b < 4294967296L) d += 4294967296L; else return double.NaN; } return d * 8 / 1e6 / dt; };   // (a 32-bit counter that went round, else a reset)
        Down = rate(i, inB); Up = rate(o, outB); inB = i; outB = o;
    }

    // ---- the speed test ----
    public static double PingS = 1, DownS = 4, UpS = 4;   // (at most: a phase ends sooner when its requests are done)
    public static int Every = 8;                     // hours; 0 = only by the button
    static double lastD = double.NaN, lastU = double.NaN, lastPing = double.NaN; static long lastAt_;   // the last test that ran
    static long baseAt;                              // the count starts here: the last test, or when it was first set up
    static long retryAt;                             // skipped: not before this
    static bool skipNoted;                           // that skip is in the list already
    static readonly List<object[]> tests = new List<object[]>();   // [unix, words], newest first
    static bool running; static string phase = ""; static double runFrom, phaseFrom, phaseAt, extraS, runD = double.NaN, runU = double.NaN, runPing = double.NaN; static long runAt;   // (extraS: seconds spent on a site that refused, so the bar keeps going on)
    public static bool Running { get { lock (gate) return running; } }

    public static void SetOn(bool on)
    {
        lock (gate) { if (On == on) return; On = on; if (on && lastAt_ == 0) baseAt = Source.Unix() - Every * 3600L + 120; retryAt = 0; skipNoted = false; }
        Log("internet: speed test " + (on ? "on" : "off"));
    }
    public static void Load()
    {
        lock (gate)
        {
            baseAt = Source.Unix() - Every * 3600L + 120;   // (never tested: the first one 2 minutes after the start)
            try
            {
                if (File_ == null || !File.Exists(File_)) return;
                var d = (Dictionary<string, object>)new JavaScriptSerializer().DeserializeObject(File.ReadAllText(File_));
                Func<string, double> N = k => d.ContainsKey(k) && d[k] != null ? Convert.ToDouble(d[k], System.Globalization.CultureInfo.InvariantCulture) : double.NaN;
                if (d.ContainsKey("every")) Every = Convert.ToInt32(d["every"]);
                lastD = N("d"); lastU = N("u"); lastPing = N("ping"); lastAt_ = double.IsNaN(N("at")) ? 0 : (long)N("at");
                if (!double.IsNaN(N("base"))) baseAt = (long)N("base");
                if (d.ContainsKey("tests") && d["tests"] is object[]) foreach (var x in (object[])d["tests"]) { var a = x as object[]; if (a != null && a.Length == 2) tests.Add(new object[] { Convert.ToInt64(a[0]), Convert.ToString(a[1]) }); }
            }
            catch (Exception ex) { Log("internet: net.json not read: " + ex.Message); DataKeep.Bad(File_, Log); }
        }
    }
    static readonly object saveGate = new object();
    static void Save() { lock (saveGate) Save0(); }   // (the test's thread and the page's both save: one at a time, the newest state last, the review 11-12)
    static void Save0()
    {
        if (File_ == null) return;
        Dictionary<string, object> d;
        lock (gate) d = new Dictionary<string, object> { { "every", Every }, { "d", Num(lastD) }, { "u", Num(lastU) }, { "ping", Num(lastPing) }, { "at", lastAt_ }, { "base", baseAt }, { "tests", tests.Take(40).ToList() } };
        try { var tmp = File_ + ".tmp"; File.WriteAllText(tmp, new JavaScriptSerializer().Serialize(d)); if (File.Exists(File_)) File.Replace(tmp, File_, null); else File.Move(tmp, File_); }
        catch (Exception ex) { Log("internet: net.json not saved: " + ex.Message); }
    }
    static object Num(double v) { return double.IsNaN(v) ? null : (object)Math.Round(v, 1); }
    static void Add(long at, string words) { lock (gate) { tests.Insert(0, new object[] { at, words }); if (tests.Count > 40) tests.RemoveRange(40, tests.Count - 40); } }

    // once a second (the reading's Second): the live rate, and a test when one is due
    public static void Tick()
    {
        Live();
        if (!On || Fake || Blocked()) return;
        long now = Source.Unix(); bool start = false, save = false;
        lock (gate)
        {
            if (running || Every <= 0 || now < Math.Max(baseAt + Every * 3600L, retryAt)) return;
            // (not in the app's first two minutes, nor the first two after a sleep, nor with the rate not known: at a sign-in
            // or a wake the network may not be up yet, and Windows' own updates may be using the line; the review 11-12)
            double up = clock.Elapsed.TotalSeconds; if (up < 120 || up - wokeAt < 120 || double.IsNaN(Down)) return;
            string why = Gaming() ? "skipped, game running" : (Down > 5 || Up > 5) ? "skipped, the line was busy" : null;
            if (why != null)
            {
                retryAt = now + 1800;
                if (!skipNoted) { skipNoted = true; tests.Insert(0, new object[] { now, why }); save = true; Log("internet: speed test " + why.Replace("skipped, ", "skipped: ") + ", again in 30 min"); }
            }
            else start = true;
        }
        if (save) Save();
        if (start) Start("on its own");
    }

    // the page: "Test now", or how often
    public static void Act(string what, string every)
    {
        if (what == "test") { if (!On) return; if (!Start("Test now")) Toast("A speed test is running"); return; }
        int h;
        if (every != null && int.TryParse(every, out h) && (h == 0 || h == 4 || h == 8 || h == 12 || h == 24))
        {
            lock (gate) { Every = h; retryAt = 0; skipNoted = false; }
            Save(); Log("internet: speed test every " + (h == 0 ? "(only by the button)" : h + " h"));
        }
    }
    static bool Start(string why)
    {
        lock (gate) { if (running) return false; running = true; phase = "ping"; runFrom = phaseFrom = clock.Elapsed.TotalSeconds; phaseAt = 0; extraS = 0; runD = runU = runPing = double.NaN; runAt = Source.Unix(); }
        Log("internet: speed test (" + why + ")");
        new System.Threading.Thread(Fake ? (System.Threading.ThreadStart)RunFake : Run) { IsBackground = true, Name = "speed test" }.Start();
        return true;
    }

    // ---- where a test goes. Cloudflare's speed test first: its Lisbon site, 3 ms away, the truest figure for his line.
    // It limits how much one address takes in a while (429 or 403, 11-12: after three tests in three minutes it
    // refused for over half an hour); then, and for an hour after, the nearest of LibreSpeed's public test servers (the
    // list its own command line client uses: Amsterdam, Frankfurt, London, 30 to 40 ms away, so a little lower on a
    // fast line). The test's row in the list names that server. (11-12, his "now it didnt work, can u test properly":
    // with Cloudflare refusing, every test failed) ----
    class Site
    {
        public string Name = "", Base = "", Ping = "", Up = "";   // Base + a path = the address
        public Func<long, string> Down;                           // the path for size bytes
        public bool Cf;                                           // Cloudflare: its ping is in its Server-Timing header
        public long UpChunk = 25000000;                           // bytes per upload request (LibreSpeed's take 4 MB at most)
        public string Url(string path) { return Base.TrimEnd('/') + "/" + path.TrimStart('/'); }
    }
    static readonly Site Cf = new Site { Name = "Cloudflare", Base = "https://speed.cloudflare.com", Cf = true, Ping = "__down?bytes=0", Up = "__up", Down = b => "__down?bytes=" + b };
    static Site libre; static long libreAt, cfRefusedAt;
    class WaitException : Exception { public WaitException() : base("429") { } }   // (the site refused: too much from this address)
    static readonly byte[] junk = MakeJunk();
    static byte[] MakeJunk() { var b = new byte[64 * 1024]; new Random(7).NextBytes(b); return b; }
    static HttpWebRequest Req(string url, string method, int ms = 8000)
    {
        var r = (HttpWebRequest)WebRequest.Create(url);
        r.Method = method; r.UserAgent = "HWDashboard"; r.Timeout = ms; r.ReadWriteTimeout = ms; r.KeepAlive = true; r.Proxy = null;
        r.AutomaticDecompression = DecompressionMethods.None;
        var sp = r.ServicePoint; if (sp.ConnectionLimit < 16) sp.ConnectionLimit = 16; sp.Expect100Continue = false; sp.UseNagleAlgorithm = false;
        return r;
    }
    static bool Refused(WebException ex) { var hr = ex.Response as HttpWebResponse; return hr != null && ((int)hr.StatusCode == 429 || (int)hr.StatusCode == 403); }
    // the nearest LibreSpeed server: the one that answers a second small request soonest (all at once, 3 s at most);
    // picked again after a day
    static Site Libre()
    {
        if (libre != null && Source.Unix() - libreAt < 86400) return libre;
        string json;
        using (var rs = Req("https://librespeed.org/backend-servers/servers.php", "GET").GetResponse()) using (var rd = new StreamReader(rs.GetResponseStream())) json = rd.ReadToEnd();
        var sites = new List<Site>();
        foreach (var o in (object[])new JavaScriptSerializer().DeserializeObject(json))
        {
            var s = o as Dictionary<string, object>; if (s == null) continue;
            Func<string, string> F = k => s.ContainsKey(k) && s[k] != null ? Convert.ToString(s[k]) : "";
            string b = F("server"), dl = F("dlURL"), name = F("name");
            if (!b.StartsWith("https://", StringComparison.OrdinalIgnoreCase) || dl == "" || F("ulURL") == "" || F("pingURL") == "") continue;
            int cut = name.IndexOfAny(new[] { ',', '(' });
            sites.Add(new Site { Name = (cut > 0 ? name.Substring(0, cut) : name).Trim(), Base = b, Ping = F("pingURL"), Up = F("ulURL"), Down = n => dl + "?ckSize=" + Math.Max(1, n / 1048576), UpChunk = 4000000 });
        }
        var ms = new double[sites.Count]; var ths = new List<System.Threading.Thread>();
        for (int i = 0; i < sites.Count; i++)
        {
            int k = i; ms[k] = double.MaxValue;
            var th = new System.Threading.Thread(() => { try { var url = sites[k].Url(sites[k].Ping); for (int n = 0; n < 2; n++) { var sw = Stopwatch.StartNew(); using (var rs = Req(url, "GET", 2500).GetResponse()) using (var st = rs.GetResponseStream()) st.CopyTo(System.IO.Stream.Null); if (n == 1) ms[k] = sw.Elapsed.TotalMilliseconds; } } catch { } }) { IsBackground = true };
            ths.Add(th); th.Start();
        }
        var until = Stopwatch.StartNew(); foreach (var th in ths) th.Join(Math.Max(0, 6000 - (int)until.ElapsedMilliseconds));
        int best = -1; for (int i = 0; i < sites.Count; i++) if (ms[i] < double.MaxValue && (best < 0 || ms[i] < ms[best])) best = i;
        if (best < 0) throw new Exception("no LibreSpeed server answered");
        libre = sites[best]; libreAt = Source.Unix();
        Log("internet: LibreSpeed's nearest server: " + sites[best].Name + " (" + sites[best].Base + "), " + ms[best].ToString("0") + " ms to answer");
        return libre;
    }

    static void RunFake()
    {
        var rnd = new Random(); double d = 905 + rnd.Next(30), u = 400 + rnd.Next(20), ping = 8 + rnd.Next(3);
        Action<string, double, double> step = (p, secs, to) =>
        {
            lock (gate) { phase = p; phaseFrom = clock.Elapsed.TotalSeconds; phaseAt = p == "ping" ? 0 : p == "down" ? PingS : PingS + DownS; }
            for (double t = 0; t < secs; t += 0.25)
            {
                System.Threading.Thread.Sleep(250);
                double k = Math.Min(1, (t + 0.25) / 1.2), v = to * k * k * (3 - 2 * k);
                lock (gate) { if (p == "down") { Down = v; runD = v; } else if (p == "up") { Up = v; runU = v; } }
            }
        };
        step("ping", PingS, 0); lock (gate) runPing = ping;
        step("down", DownS, d); lock (gate) runD = d;
        step("up", UpS, u);
        long at;
        lock (gate) { at = runAt; running = false; phase = ""; baseAt = at; retryAt = 0; skipNoted = false; lastD = d; lastU = u; lastPing = ping; lastAt_ = at; }
        Add(at, Row(d, u, ping, "made up"));
        Log("internet: speed test (made up) " + Math.Round(d) + " down, " + Math.Round(u) + " up");
        Save();
    }
    static void Run()
    {
        double d = double.NaN, u = double.NaN, ping = double.NaN; string fail = null; Site site = null; var tw = Stopwatch.StartNew(); string times = "", downRates = "";
        string before = (double.IsNaN(Down) ? "--" : Down.ToString("0.0", ic)) + " down, " + (double.IsNaN(Up) ? "--" : Up.ToString("0.0", ic)) + " up Mbit/s"; cfColo = "";
        try
        {
            ServicePointManager.SecurityProtocol |= (SecurityProtocolType)3072;   // TLS 1.2
            bool cfOk; lock (gate) cfOk = Source.Unix() - cfRefusedAt >= 3600;
            // (is Cloudflare taking large downloads from this address now? Asked first, with the start of one: it
            // refuses at once (429 / 403) or starts sending, and the request is dropped at its first bytes. So the test
            // runs on one site from its start, and its bar and seconds left never go back, 11-12)
            if (cfOk)
            {
                var pr = Req(Cf.Url(Cf.Down(25000000)), "GET", 4000); WebResponse prs = null;
                try { prs = pr.GetResponse(); }
                catch (WebException ex) { if (Refused(ex)) { cfOk = false; lock (gate) cfRefusedAt = Source.Unix(); Log("internet: Cloudflare refuses large downloads from this address for now, the test on LibreSpeed's nearest server (for an hour)"); } }
                finally { try { pr.Abort(); } catch { } if (prs != null) try { prs.Close(); } catch { } }   // (dropped first: a close alone would read the rest)
            }
            for (int attempt = 0; ; attempt++)
            {
                site = cfOk && attempt == 0 ? Cf : Libre();
                bool haveDown = !double.IsNaN(d);   // (refused at the upload: its download stays, the test keeps to 0.4 GB, the review 11-12)
                lock (gate) { extraS = clock.Elapsed.TotalSeconds - runFrom - (haveDown ? PingS + DownS : 0); if (!haveDown) { phase = "ping"; phaseFrom = clock.Elapsed.TotalSeconds; phaseAt = 0; runD = runU = runPing = double.NaN; } }
                try
                {
                    var t = Stopwatch.StartNew();
                    if (!haveDown)
                    {
                        ping = Ping(site); lock (gate) runPing = ping;
                        times = "ping " + t.Elapsed.TotalSeconds.ToString("0.0", ic) + " s"; t.Restart();
                        lock (gate) { phase = "down"; phaseFrom = clock.Elapsed.TotalSeconds; phaseAt = PingS; }
                        d = Measure(site, true, site.Cf ? 3 : 6, DownS, 25000000, 250000000);
                        lock (gate) downRates = lastRates;
                        times += ", down " + t.Elapsed.TotalSeconds.ToString("0.0", ic) + " s"; t.Restart();
                    }
                    lock (gate) { runD = d; phase = "up"; phaseFrom = clock.Elapsed.TotalSeconds; phaseAt = PingS + DownS; }
                    u = Measure(site, false, 6, UpS, site.UpChunk, 150000000);   // (six on both: Cloudflare's three gave 236 to 383 Mbit/s up on a line LibreSpeed's six read at 430 to 460, 11-12)
                    times += ", up " + t.Elapsed.TotalSeconds.ToString("0.0", ic) + " s";
                    break;
                }
                catch (Exception ex)
                {
                    bool refused = ex is WaitException || (ex is WebException && Refused((WebException)ex));
                    if (!(refused && site.Cf)) throw;
                    lock (gate) cfRefusedAt = Source.Unix();
                    Log("internet: Cloudflare refused (too many tests from this address for now), on LibreSpeed's nearest server for an hour");
                }
            }
        }
        catch (Exception ex) { fail = ex is WaitException || (ex is WebException && Refused((WebException)ex)) ? "wait" : ex is WebException && ((WebException)ex).Response == null ? "no answer" : ex.Message; }
        long at; bool ok = fail == null && !double.IsNaN(d) && !double.IsNaN(u);
        // (its place looked up and its row in BEFORE the test counts as over: the lookup can take seconds, and meanwhile the
        // popup lost its running row and Test now could start another test, the review 11-12)
        string place = ok ? (site.Cf ? CfCity() : site.Name) : null;
        lock (gate) at = runAt;
        Add(at, ok ? Row(d, u, ping, place) : fail == "wait" ? "failed, the test site said to wait" : "failed, no answer");
        lock (gate)
        {
            running = false; phase = ""; baseAt = at; retryAt = 0; skipNoted = false;
            if (ok) { lastD = d; lastU = u; lastPing = ping; lastAt_ = at; }
        }
        if (ok)
        {
            Log("internet: speed test " + d.ToString("0.0", ic) + " down, " + u.ToString("0.0", ic) + " up, ping " + (double.IsNaN(ping) ? "--" : ping.ToString("0.0", ic)) + " ms, " + (site.Cf ? "Cloudflare " + place + (cfColo != "" ? " (" + cfColo + ")" : "") : site.Name) + " (" + times + ", " + tw.Elapsed.TotalSeconds.ToString("0.0", ic) + " s in all; per second: " + downRates + ", " + lastRates + "; the line before: " + before + ")");
        }
        else
        {
            Log("internet: speed test failed after " + tw.Elapsed.TotalSeconds.ToString("0.0", ic) + " s" + (site != null ? " on " + site.Name : "") + ": " + (fail == "wait" ? "the site refused (429 / 403)" : fail ?? "no data came"));
        }
        Save();
    }
    static readonly System.Globalization.CultureInfo ic = System.Globalization.CultureInfo.InvariantCulture;
    // a test's row: "810 down, 403 up, 3 ms, Lisbon"; the ping and the place left out when not known
    static string Row(double d, double u, double ping, string place)
    {
        return Math.Round(d).ToString("0", ic) + " down, " + Math.Round(u).ToString("0", ic) + " up" + (double.IsNaN(ping) || ping <= 0 ? "" : ", " + Math.Max(1, Math.Round(ping)).ToString("0", ic) + " ms") + (string.IsNullOrEmpty(place) ? "" : ", " + place);
    }
    static string lastRates = "";   // (the log: each second's rate of the last part measured)
    // Cloudflare's site by the code at the end of its CF-RAY header ("...-LIS"), named from its own list of sites
    // (speed.cloudflare.com/locations, read once a run; the code itself when it isn't there). His line goes to Lisbon,
    // sometimes Bordeaux over IPv6 (11-12): the row says which
    static string cfColo = ""; static Dictionary<string, string> cfCities;
    static string CfCity()
    {
        if (cfColo == "") return "";
        if (cfCities == null)
        {
            var m = new Dictionary<string, string>();
            try
            {
                var r = Req(Cf.Base + "/locations", "GET", 4000); r.Referer = Cf.Base + "/";
                string json; using (var rs = r.GetResponse()) using (var rd = new StreamReader(rs.GetResponseStream())) json = rd.ReadToEnd();
                foreach (var o in (object[])new JavaScriptSerializer().DeserializeObject(json)) { var d = o as Dictionary<string, object>; if (d != null && d.ContainsKey("iata") && d.ContainsKey("city")) m[Convert.ToString(d["iata"])] = Convert.ToString(d["city"]); }
            }
            catch { }
            if (m.Count > 0) cfCities = m;
            else return Known(cfColo);
        }
        string c; return cfCities.TryGetValue(cfColo, out c) && !string.IsNullOrEmpty(c) ? c : Known(cfColo);
    }
    // a few of Cloudflare's sites by their code, for when its own list can't be read (his line: Lisbon, sometimes
    // Bordeaux); another code: no place rather than a code
    static string Known(string code)
    {
        switch (code) { case "LIS": return "Lisbon"; case "OPO": return "Porto"; case "BOD": return "Bordeaux"; case "MAD": return "Madrid"; case "BCN": return "Barcelona"; case "CDG": return "Paris"; case "MRS": return "Marseille"; case "LHR": return "London"; case "AMS": return "Amsterdam"; case "FRA": return "Frankfurt"; default: return ""; }
    }
    // the ping: small requests on one connection, the quickest after the first (that one opens it). Cloudflare: the
    // round trip its own server measured on the connection (Server-Timing "cfL4 ... min_rtt", microseconds: 3.3 ms to
    // Lisbon, as a plain ping says); a request's own time is no ping there, its worker takes 20 to 60 ms to answer
    // (44 and 70 ms in his first tests, 11-12). Elsewhere: the request less any time the server says it took
    static double Ping(Site site)
    {
        var pw = Stopwatch.StartNew(); double best = double.MaxValue, rtt = double.MaxValue; var fl = System.Globalization.NumberStyles.Float;
        for (int k = 0; k < 8 && (k < 3 || pw.Elapsed.TotalSeconds < PingS); k++)
        {
            var sw = Stopwatch.StartNew(); double srv = 0;
            using (var rs = (HttpWebResponse)Req(site.Url(site.Ping), "GET").GetResponse())
            {
                var st = rs.Headers["Server-Timing"] ?? "";
                var ray = rs.Headers["CF-RAY"] ?? ""; int dash = ray.LastIndexOf('-'); if (site.Cf && dash > 0 && dash < ray.Length - 1) cfColo = ray.Substring(dash + 1).Trim().ToUpperInvariant();
                var mr = System.Text.RegularExpressions.Regex.Match(st, @"min_rtt=(\d+)"); double us;
                if (mr.Success && double.TryParse(mr.Groups[1].Value, fl, ic, out us) && us > 0) rtt = Math.Min(rtt, us / 1000);
                foreach (System.Text.RegularExpressions.Match m in System.Text.RegularExpressions.Regex.Matches(st, @"dur=([0-9.]+)")) { double v; if (double.TryParse(m.Groups[1].Value, fl, ic, out v)) srv += v; }
                using (var s = rs.GetResponseStream()) s.CopyTo(System.IO.Stream.Null);
            }
            double ms = sw.Elapsed.TotalMilliseconds - srv;
            if (k > 0 && ms > 0) best = Math.Min(best, ms);
        }
        if (site.Cf && rtt < double.MaxValue) return rtt;
        return best < double.MaxValue ? best : double.NaN;
    }
    // conns connections at once, each one request of size bytes after another until budget bytes are asked for in all,
    // for secs at most: the rate over each second while all of them still run (sampled every 250 ms, after the first
    // half second: the connections ramping up), the middle one of those, in Mbit/s. A line too fast for a whole second
    // of that: the bytes over the time they took. The live figure for the popup while it runs: the last second's. A
    // refusal (429 / 403) before a quarter of a request came: WaitException
    static double Measure(Site site, bool down, int conns, double secs, long size, long budget)
    {
        long total = 0, asked = 0; int active = conns, refused = 0; var t0 = Stopwatch.StartNew(); var stop = new System.Threading.ManualResetEvent(false); var reqs = new List<HttpWebRequest>();
        var workers = new List<System.Threading.Thread>();
        for (int c = 0; c < conns; c++)
        {
            var th = new System.Threading.Thread(() =>
            {
                var buf = new byte[64 * 1024]; HttpWebRequest r = null;
                try
                {
                    while (!stop.WaitOne(0) && System.Threading.Interlocked.Add(ref asked, size) <= budget)
                    {
                        if (down)
                        {
                            r = Req(site.Url(site.Down(size)), "GET"); lock (reqs) reqs.Add(r);
                            using (var rs = r.GetResponse()) using (var s = rs.GetResponseStream())
                                for (int n; !stop.WaitOne(0) && (n = s.Read(buf, 0, buf.Length)) > 0;) System.Threading.Interlocked.Add(ref total, n);
                        }
                        else
                        {
                            r = Req(site.Url(site.Up), "POST"); r.ContentType = "application/octet-stream"; r.AllowWriteStreamBuffering = false; r.SendChunked = false;
                            r.ContentLength = size; lock (reqs) reqs.Add(r);
                            using (var s = r.GetRequestStream())
                                for (long left = size; left > 0 && !stop.WaitOne(0);) { int n = (int)Math.Min(junk.Length, left); s.Write(junk, 0, n); left -= n; System.Threading.Interlocked.Add(ref total, n); }
                            if (!stop.WaitOne(0)) using (r.GetResponse()) { }
                        }
                        lock (reqs) reqs.Remove(r); r = null;
                    }
                }
                catch (WebException ex) { if (Refused(ex)) System.Threading.Interlocked.Exchange(ref refused, 1); }
                catch { }
                finally { if (r != null) lock (reqs) reqs.Remove(r); System.Threading.Interlocked.Decrement(ref active); }
            }) { IsBackground = true, Name = "speed test " + (down ? "down" : "up") };
            workers.Add(th); th.Start();
        }
        var at = new List<double>(); var bytes = new List<long>(); var all = new List<bool>();
        double prevT = 0; long prevB = 0, firstB = -1; double firstT = 0, lastFullT = 0; long lastFullB = 0;
        while (t0.Elapsed.TotalSeconds < secs && System.Threading.Thread.VolatileRead(ref active) > 0 && System.Threading.Thread.VolatileRead(ref refused) == 0)
        {
            System.Threading.Thread.Sleep(250);
            double t = t0.Elapsed.TotalSeconds; long b = System.Threading.Interlocked.Read(ref total); bool full = System.Threading.Thread.VolatileRead(ref active) == conns;
            at.Add(t); bytes.Add(b); all.Add(full);
            if (t >= 0.5 && firstB < 0) { firstB = b; firstT = t; }
            if (full) { lastFullT = t; lastFullB = b; }
            if (t - prevT >= 1) { double now = (b - prevB) * 8 / 1e6 / (t - prevT); lock (gate) { if (down) runD = now; else runU = now; } prevT = t; prevB = b; }
        }
        stop.Set();
        lock (reqs) foreach (var r in reqs.ToList()) { try { r.Abort(); } catch { } }
        foreach (var th in workers) th.Join(3000);
        if (refused != 0 && System.Threading.Interlocked.Read(ref total) < size / 4) throw new WaitException();
        var rates = new List<double>();
        for (int i = 0; i < at.Count; i++)
        {
            if (at[i] < 0.5 || !all[i]) continue;
            for (int j = i + 1; j < at.Count && all[j]; j++)
                if (at[j] - at[i] >= 0.99) { rates.Add((bytes[j] - bytes[i]) * 8 / 1e6 / (at[j] - at[i])); break; }
        }
        lock (gate) lastRates = (down ? "down " : "up ") + string.Join(" ", rates.Select(r => r.ToString("0", ic)));
        if (rates.Count >= 2) { rates.Sort(); return rates[Math.Max(0, (int)Math.Ceiling(0.9 * rates.Count) - 1)]; }   // (the 90th percentile, as Cloudflare's own test; the middle one read low on a 2 s test, his 810, 11-12)
        if (firstB >= 0 && lastFullT > firstT && lastFullB > firstB) return (lastFullB - firstB) * 8 / 1e6 / (lastFullT - firstT);
        long tb = System.Threading.Interlocked.Read(ref total); double te = t0.Elapsed.TotalSeconds;
        if (tb <= 0) throw new Exception("no data came");
        return tb * 8 / 1e6 / te;
    }

    // for the page, every second (x.live "net")
    public static Dictionary<string, object> State()
    {
        lock (gate)
        {
            var o = new Dictionary<string, object> { { "on", On }, { "link", Link }, { "every", Every }, { "tests", tests.Take(12).ToList() } };
            if (!double.IsNaN(lastD)) o["last"] = new Dictionary<string, object> { { "d", Math.Round(lastD) }, { "u", Math.Round(lastU) }, { "ping", Num(lastPing) }, { "at", lastAt_ } };
            if (Every > 0 && On && !Fake && !Blocked()) o["next"] = Math.Max(baseAt + Every * 3600L, retryAt);
            if (running)
            {
                double ph = phase == "ping" ? PingS : phase == "down" ? DownS : UpS, el = extraS + phaseAt + Math.Min(ph, clock.Elapsed.TotalSeconds - phaseFrom), all = extraS + PingS + DownS + UpS;
                o["run"] = new Dictionary<string, object> { { "p", phase }, { "pct", Math.Round(Math.Min(100, el / all * 100), 1) }, { "left", Math.Max(1, (int)Math.Ceiling(all - el)) },
                    { "d", Num(runD) }, { "u", Num(runU) }, { "ping", Num(runPing) }, { "at", runAt },
                    // (for the popup's bar to move steadily: the planned seconds, where this step ends, its length)
                    { "all", Math.Round(all, 2) }, { "pe", Math.Round(Math.Min(100, (extraS + phaseAt + ph) / all * 100), 2) }, { "pl", ph } };
            }
            return o;
        }
    }
}

class Connector
{
    public const string Key = "hwdeck.0/12v";
    static readonly Regex PinA = new Regex(@"^GPU 12VHPWR Pin(\d+) Current$"), PinW = new Regex(@"^GPU 12VHPWR Pin(\d+) Power$"), PinV = new Regex(@"^GPU 12VHPWR Pin(\d+) Voltage$");
    int[] a = new int[0], w = new int[0];
    // for the page: the pins' current keys, then their power keys; and, where HWiNFO shares each pin's voltage (11-11:
    // his card does), a third list, the voltage key of each pin of the first list, null for a pin without one
    public object[] Keys = new object[0];
    public double Worst = double.NaN, Share;    // the most loaded pin (A); its load against the average
    public int Hot = -1;                        // which pin that is (from 0)
    public bool Lopsided;                       // a pin over 1.5x its share, at 15 A or more in all
    public double[] A = new double[0], W = new double[0];
    public bool Has { get { return a.Length >= 2; } }
    public void Find(Source src)
    {
        var ma = new SortedDictionary<int, int>(); var mw = new SortedDictionary<int, int>(); var mv = new Dictionary<int, int>();
        for (int i = 0; i < src.Readings.Count; i++)
        {
            var r = src.Readings[i]; Match m;
            if ((m = PinA.Match(r.Label)).Success || (!string.IsNullOrEmpty(r.Orig) && (m = PinA.Match(r.Orig)).Success)) { int k = int.Parse(m.Groups[1].Value); if (!ma.ContainsKey(k)) ma[k] = i; }
            else if ((m = PinW.Match(r.Label)).Success || (!string.IsNullOrEmpty(r.Orig) && (m = PinW.Match(r.Orig)).Success)) { int k = int.Parse(m.Groups[1].Value); if (!mw.ContainsKey(k)) mw[k] = i; }
            else if ((m = PinV.Match(r.Label)).Success || (!string.IsNullOrEmpty(r.Orig) && (m = PinV.Match(r.Orig)).Success)) { int k = int.Parse(m.Groups[1].Value); if (!mv.ContainsKey(k)) mv[k] = i; }
        }
        a = ma.Values.ToArray(); w = mw.Values.ToArray();
        var ka = a.Select(i => (object)src.Readings[i].Key).ToList(); var kw = w.Select(i => (object)src.Readings[i].Key).ToList();
        Keys = mv.Count == 0 ? new object[] { ka, kw } : new object[] { ka, kw, ma.Keys.Select(k => mv.ContainsKey(k) ? (object)src.Readings[mv[k]].Key : null).ToList() };
    }
    public void Poll(Source src)
    {
        Func<int, double> at = i => i < src.Values.Length ? src.Values[i] : double.NaN;
        A = a.Select(at).ToArray(); W = w.Select(at).ToArray();
        double max = double.NaN, tot = 0; int n = 0; Hot = -1;
        for (int i = 0; i < A.Length; i++) if (!double.IsNaN(A[i])) { tot += A[i]; n++; if (double.IsNaN(max) || A[i] > max) { max = A[i]; Hot = i; } }
        Worst = n > 0 ? max : double.NaN;
        Share = n > 0 && tot > 0 ? max / (tot / n) : 0;
        Lopsided = n >= 2 && tot >= 15 && Share >= 1.5;
    }
}

// the game's own frames, counted by HW Deck: a real-time Windows trace (ETW) of DXGI's Present calls, the events
// PresentMon goes by (Microsoft-Windows-DXGI, event 42 = Present start), kept only for the game's process. HWiNFO's
// PresentMon sensor reports whichever app presents the most frames (a browser, Discord, a game's own launcher), so its
// fps can be another app's under the game's name. Windows lets admins and the Performance Log Users group start such
// a trace. DirectX 10 to 12 games; Vulkan and OpenGL ones present elsewhere (their fps stay HWiNFO's)
class Frames
{
    public const string FpsKey = "hwdeck.0/fps", LowKey = "hwdeck.0/fps1", FtKey = "hwdeck.0/ft";
    static readonly Guid Dxgi = new Guid("CA11C036-0102-4A2D-A6AD-F03CFED5D3C9");
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode)] static extern int StartTraceW(out ulong handle, string name, IntPtr props);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode)] static extern int ControlTraceW(ulong handle, string name, IntPtr props, uint code);
    [DllImport("advapi32.dll")] static extern int EnableTraceEx2(ulong handle, ref Guid provider, uint code, byte level, ulong any, ulong all, uint timeout, IntPtr parms);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode)] static extern ulong OpenTraceW(IntPtr logfile);
    [DllImport("advapi32.dll")] static extern int ProcessTrace(ulong[] handles, uint count, IntPtr start, IntPtr end);
    [DllImport("advapi32.dll")] static extern int CloseTrace(ulong handle);
    [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate void RecordCallback(IntPtr rec);
    const int PropsSize = 120, NameMax = 512;   // EVENT_TRACE_PROPERTIES on x64, then the session's name

    readonly string name;                   // one session per HW Deck data folder and account (a test copy beside the real one)
    ulong session, trace;
    RecordCallback cb;                      // (kept alive: the trace calls it from its own thread)
    System.Threading.Thread thread;
    volatile int gamePid;                   // the game's process (0: none): only its frames are kept
    public int Pid
    {
        get { return gamePid; }
        set
        {
            if ((gamePid == 0) != (value == 0)) { var t = flushTimer; if (t != null && flushFails < 5) try { if (value == 0) t.Change(System.Threading.Timeout.Infinite, System.Threading.Timeout.Infinite); else t.Change(FlushMs, FlushMs); } catch { } }   // (2.1: the flush timer sleeps with no game, the perf audit 11-04)
            // (11-06: the provider goes off after 10 s with no game, see Second; a game in front turns it on at once)
            if (gamePid == 0 && value != 0 && provOff && State == "on") try { Enable(); } catch { }
            if (gamePid != 0 && value == 0) zeroAt = Environment.TickCount;
            gamePid = value;
        }
    }
    readonly long[] ring = new long[16384]; int head, count, ringPid;   // present times (QPC), the newest at head - 1
    volatile int seenPid;                   // the last process whose frames came in (it presents through DXGI)
    int lastPid; long pidAt;                // the process the last second looked at, and since when (QPC)
    readonly object lk = new object();
    public string State = "off";            // off | on | denied (no rights: not admin, not in Performance Log Users) | failed
    public bool On { get { return State == "on"; } }
    public double Fps = double.NaN, Low = double.NaN, Ft = double.NaN;   // this second's, for the game (NaN: no game)
    public Frames(string name) { this.name = name; cb = OnRecord; stallAt = unchecked(Environment.TickCount - 10000); zeroAt = Environment.TickCount; }

    IntPtr Props()
    {
        IntPtr p = Marshal.AllocHGlobal(PropsSize + NameMax * 2);
        for (int i = 0; i < PropsSize + NameMax * 2; i += 4) Marshal.WriteInt32(p, i, 0);
        Marshal.WriteInt32(p, 0, PropsSize + NameMax * 2);   // Wnode.BufferSize
        Marshal.WriteInt32(p, 40, 1);                        // Wnode.ClientContext: QPC time stamps
        Marshal.WriteInt32(p, 44, 0x20000);                  // Wnode.Flags: WNODE_FLAG_TRACED_GUID
        Marshal.WriteInt32(p, 48, 64);                       // BufferSize (KB)
        Marshal.WriteInt32(p, 56, 128);                      // MaximumBuffers: room for a moment the reader falls behind (made only if needed)
        Marshal.WriteInt32(p, 64, 0x100);                    // LogFileMode: EVENT_TRACE_REAL_TIME_MODE
        Marshal.WriteInt32(p, 68, 1);                        // FlushTimer (s): frames reach the counter within a second (and every FlushMs, see Flush)
        Marshal.WriteInt32(p, 116, PropsSize);               // LoggerNameOffset
        return p;
    }
    // stops a session of this name left by a run that ended without stopping it (a crash keeps it until a restart)
    void StopNamed()
    {
        IntPtr p = Props();
        try { ControlTraceW(0, name, p, 1 /*EVENT_TRACE_CONTROL_STOP*/); } finally { Marshal.FreeHGlobal(p); }
    }
    public void Start()
    {
        if (On) return;
        StopFlush();   // (started again after another program stopped the trace: the last run's flush goes first)
        try
        {
            StopNamed();
            IntPtr p = Props(); int err;
            try { err = StartTraceW(out session, name, p); } finally { Marshal.FreeHGlobal(p); }
            if (err != 0) { State = err == 5 ? "denied" : "failed"; return; }   // 5: access denied
            err = Enable();
            if (err != 0) { StopNamed(); State = err == 5 ? "denied" : "failed"; return; }
            IntPtr lf = Marshal.AllocHGlobal(448), ln = Marshal.StringToHGlobalUni(name);   // EVENT_TRACE_LOGFILEW on x64
            try
            {
                for (int i = 0; i < 448; i += 4) Marshal.WriteInt32(lf, i, 0);
                Marshal.WriteIntPtr(lf, 8, ln);                                   // LoggerName
                // real time, EVENT_RECORD, raw time stamps (the session's QPC clock, as Stopwatch; without it, system time)
                Marshal.WriteInt32(lf, 28, 0x100 | 0x1000 | 0x10000000);
                Marshal.WriteIntPtr(lf, 424, Marshal.GetFunctionPointerForDelegate(cb));   // EventRecordCallback
                trace = OpenTraceW(lf);
            }
            finally { Marshal.FreeHGlobal(ln); Marshal.FreeHGlobal(lf); }
            if (trace == ulong.MaxValue) { StopNamed(); State = "failed"; return; }
            ulong t = trace;
            State = "on";   // (before the thread starts: a trace that ends at once turns it to failed, not the other way round)
            if (FlushMs > 0) { flushProps = Props(); System.Threading.Interlocked.Exchange(ref flushAt, 0); flushFails = 0; flushTimer = new System.Threading.Timer(Flush, null, gamePid != 0 ? FlushMs : System.Threading.Timeout.Infinite, gamePid != 0 ? FlushMs : System.Threading.Timeout.Infinite); }   // (asleep until a game is in front, 2.1)
            thread = new System.Threading.Thread(() =>
            {
                try { ProcessTrace(new[] { t }, 1, IntPtr.Zero, IntPtr.Zero); } catch { }
                if (State == "on" && trace == t) State = "failed";   // ended without a Stop: another program stopped it
            }) { IsBackground = true, Name = "frames" };
            thread.Start();
        }
        catch { State = "failed"; }
    }
    public void Stop()
    {
        if (State != "on" && State != "failed") return;
        State = "off";
        StopFlush();   // (first: none reaches a session that is going)
        try { StopNamed(); } catch { }
        try { CloseTrace(trace); } catch { }
        trace = 0;
        lock (lk) { count = 0; }
        Fps = Low = Ft = double.NaN;
    }
    // the trace's thread, for every DXGI event of every process: EVENT_HEADER.Flags at 4, ProcessId at 12, TimeStamp at
    // 16, EventDescriptor.Id at 40; EVENT_RECORD.UserDataLength at 86, UserData at 96: Present_Start's swap chain (a
    // pointer, 4 bytes from a 32-bit process) then its Flags
    // (2.1: PresentMultiplaneOverlay_Start, 55, counts too, a game that presents that way showed no frames; its payload's
    // layout isn't checked, so its DXGI_PRESENT_TEST calls aren't told apart)
    void OnRecord(IntPtr rec)
    {
        int id = Marshal.ReadInt16(rec, 40);
        if (id != 42 && id != 55) return;
        int pid = Marshal.ReadInt32(rec, 12);
        if (pid == 0 || pid != Pid) return;
        int at = (Marshal.ReadInt16(rec, 4) & 0x20) != 0 ? 4 : 8;   // EVENT_HEADER_FLAG_32_BIT_HEADER
        IntPtr data = Marshal.ReadIntPtr(rec, 96); int len = Marshal.ReadInt16(rec, 86);
        long chain = 0; int sync = -1;
        if (id == 42 && data != IntPtr.Zero && len >= at + 4)
        {
            if ((Marshal.ReadInt32(data, at) & 1) != 0) return;   // DXGI_PRESENT_TEST
            chain = at == 8 ? Marshal.ReadInt64(data, 0) : Marshal.ReadInt32(data, 0);   // (the swap chain; then its Flags, its SyncInterval)
            if (len >= at + 8) sync = Marshal.ReadInt32(data, at + 4);
        }
        long ts = Marshal.ReadInt64(rec, 16);
        lock (lk)
        {
            if (ringPid != pid) { ringPid = pid; count = 0; }
            ring[head] = ts; head = (head + 1) % ring.Length; if (count < ring.Length) count++;
            if (chain != 0) chains.Add(chain);
            if (sync >= 0) lastSync = sync;
        }
        seenPid = pid;
    }
    // once a second: the fps of the last second of frames that came in, the 1% low over the last 10 s (the 99th
    // percentile frame time), the frame time; no frames for 3 s (a paused or hidden game): 0 fps. A game that hasn't
    // presented through DXGI since it came to the front (Vulkan, OpenGL, DirectX 9, or just back from an alt-tab) has
    // no number yet: nothing, not 0 (its sessions take HWiNFO's fps instead, see Games.Feed)
    int stallAt;   // the last time the trace was asked again for frames that stopped coming (TickCount, compared unchecked)
    int stallWait = 5000, zeroAt;   // (how long till the next ask for a game that never presented; when the last game left the front)
    volatile bool provOff;          // (the provider turned off: no game in front for 10 s)
    readonly List<long> tsBuf = new List<long>(4096);    // (kept between seconds: no new lists while a game runs; 2.1, the perf audit 11-04)
    readonly List<double> gapBuf = new List<double>(4096);
    public void Second()
    {
        Steady = null; PaceLine = null; AgeMs = double.NaN;
        long f = System.Diagnostics.Stopwatch.Frequency, now = System.Diagnostics.Stopwatch.GetTimestamp();
        int pid = Pid;
        if (pid != lastPid) { lastPid = pid; pidAt = now; stallWait = 5000; }
        if (!On || pid == 0)
        {
            Fps = Low = Ft = double.NaN;
            // (no game in front for 10 s: the provider off, so no program writes its presents for nothing; 10 s: an
            // alt-tab back and forth doesn't turn it off and on, 11-06)
            if (On && pid == 0 && !provOff && unchecked(Environment.TickCount - zeroAt) > 10000)
                try { var g = Dxgi; if (EnableTraceEx2(session, ref g, 0 /*EVENT_CONTROL_CODE_DISABLE_PROVIDER*/, 0, 0, 0, 0, IntPtr.Zero) == 0) provOff = true; } catch { }
            return;
        }
        // no frames for 3 s: a paused game, or another program that stopped its own trace of the same events turned
        // them off for everyone: asked again, at most every 5 s (cheap; a paused game simply stays at 0)
        // (11-06: a game that never presented through DXGI, Vulkan, OpenGL, DirectX 9: after 5 s, 30 s, then every 5 min)
        if (double.IsNaN(Fps) || Fps == 0) { int n = Environment.TickCount, wait = seenPid == pid ? 5000 : stallWait; if (unchecked(n - stallAt) > wait) { stallAt = n; if (seenPid != pid) stallWait = stallWait < 30000 ? 30000 : 300000; try { Enable(); } catch { } } }
        if (++seconds % 10 == 0) QueryLost();
        var ts = tsBuf; ts.Clear(); int nChains, sync;
        lock (lk)
        {
            if (ringPid != pid) count = 0;
            for (int i = count; i >= 1; i--) { long t = ring[(head - i + ring.Length) % ring.Length]; if (t >= now - 11 * f && t >= pidAt) ts.Add(t); }
            nChains = chains.Count; chains.Clear(); sync = lastSync;
        }
        if (pid != stablePid) { stablePid = pid; rates.Clear(); }
        ts.Sort();   // (events come one buffer per CPU, not quite in order)
        if (ts.Count == 0 && (seenPid != pid || now - pidAt < 3 * f)) { Fps = Low = Ft = double.NaN; rates.Clear(); Stable = false; return; }   // (not a DXGI game, or not yet)
        if (ts.Count == 0 || ts[ts.Count - 1] < now - 3 * f) { Fps = 0; Low = Ft = double.NaN; rates.Clear(); Stable = false; return; }
        long last = ts[ts.Count - 1];
        if (last - f < pidAt) { Fps = Low = Ft = double.NaN; return; }   // (in front for less than the whole second: a part of a second's frames)
        int n1 = 0; for (int i = ts.Count - 1; i >= 0 && ts[i] > last - f; i--) n1++;   // (sorted: the newest second's from the end)
        Fps = n1;
        rates.Enqueue(n1); while (rates.Count > StableSecs) rates.Dequeue();
        Stable = StableRate(rates);
        AgeMs = (now - last) * 1000.0 / f;
        Ft = n1 > 0 ? 1000.0 / n1 : double.NaN;
        var gaps = gapBuf; gaps.Clear();
        // (a gap of a second or more is a pause, an alt-tab or a loading screen, not a frame of the game)
        for (int i = 1; i < ts.Count; i++) if (ts[i] > last - 10 * f) { double g = (ts[i] - ts[i - 1]) * 1000.0 / f; if (g < 1000) gaps.Add(g); }
        if (gaps.Count >= 30) { gaps.Sort(); double p99 = gaps[Math.Min(gaps.Count - 1, (int)Math.Ceiling(gaps.Count * 0.99) - 1)]; Low = p99 > 0 ? 1000.0 / p99 : double.NaN; }
        else Low = double.NaN;
        // (the pace's 5 s end at the newest present it has: measured 11-04 against a presenter's own list of its frames,
        // none missing in that window in any mode, with the flush every 250 ms)
        long fa = System.Threading.Interlocked.Read(ref flushAt);
        bool flushed = fa > 0 && now - fa < f;
        Steady = Pace(ts, now, f);
        if (LogPace)
        {
            var inv = System.Globalization.CultureInfo.InvariantCulture;
            PaceLine = PaceText(ts, f);
            if (PaceLine != null) PaceLine += "  age " + AgeMs.ToString("0", inv) + "  flushed " + (flushed ? 1 : 0) + "  stable " + (Stable ? 1 : 0) + "  lost " + Lost + "  chains " + nChains + "  sync " + sync;
        }
    }
    // ---- 2.1: fresher frames (11-04 research: the 1 s FlushTimer left the newest frames up to 1.9 s old when the pace was
    // judged, so it said "nothing to tell by" 3 seconds in 4 at a 119 fps menu cap). While a game is counted, the session
    // is flushed every FlushMs: a flush call takes about 0.1 ms and doesn't touch the game (its events are written in
    // its own threads whatever the flush does); measured on his PC, with this filter, a flush every 8 ms left a CPU-bound
    // presenter's fps within noise. 0: off (tests) ----
    public static int FlushMs = 250;
    System.Threading.Timer flushTimer; IntPtr flushProps; long flushAt; int flushFails;
    public double AgeMs = double.NaN;       // this second's newest present's age (ms; NaN: none)
    public int Lost;                        // events and buffers the session lost so far (checked every 10 s; -1 the check refused)
    public bool Seen { get { int p = Pid; return p != 0 && seenPid == p; } }   // the game in front presents through DXGI (its frames come in)
    int seconds;
    readonly HashSet<long> chains = new HashSet<long>(); int lastSync = -1;   // this second's swap chains, the last SyncInterval
    // the flush timer stopped, waiting for a call under way, then its buffer freed
    void StopFlush()
    {
        var tm = flushTimer; flushTimer = null;
        if (tm != null) try { using (var w = new System.Threading.ManualResetEvent(false)) { if (tm.Dispose(w)) w.WaitOne(2000); } } catch { }
        var fp = flushProps; flushProps = IntPtr.Zero;
        if (fp != IntPtr.Zero) Marshal.FreeHGlobal(fp);
    }
    void Flush(object _)
    {
        var fp = flushProps;   // (read once: StopFlush frees it only after this call is done)
        if (State != "on" || Pid == 0 || fp == IntPtr.Zero) return;
        // (by the session's name, not its handle: never another session that took the number over after a stop)
        int err; try { err = ControlTraceW(0, name, fp, 3 /*EVENT_TRACE_CONTROL_FLUSH*/); } catch { err = -1; }
        if (err == 0) { System.Threading.Interlocked.Exchange(ref flushAt, System.Diagnostics.Stopwatch.GetTimestamp()); flushFails = 0; }
        else if (++flushFails >= 5) { var t = flushTimer; if (t != null) try { t.Change(System.Threading.Timeout.Infinite, System.Threading.Timeout.Infinite); } catch { } }   // (refused: the 1 s timer as before)
    }
    public void QueryLostNow() { QueryLost(); }   // (tests)
    public long LastFlush { get { return System.Threading.Interlocked.Read(ref flushAt); } }   // (tests: QPC when the last flush returned, 0 none)
    void QueryLost()
    {
        IntPtr q = Props();
        try { Lost = ControlTraceW(0, name, q, 0 /*EVENT_TRACE_CONTROL_QUERY*/) == 0 ? Marshal.ReadInt32(q, 88) + Marshal.ReadInt32(q, 100) : -1; }   // EventsLost, RealTimeBuffersLost (-1: the check refused)
        catch { } finally { Marshal.FreeHGlobal(q); }
    }
    // the provider, only Present_Start (42) and PresentMultiplaneOverlay_Start (55): DXGI's other events stay unwritten in
    // the game (2.1: about 5 times fewer events, measured). An older Windows that refuses the filter gets them all
    public static bool Filter = true;   // (tests: false enables every DXGI event, as before 2.1)
    int Enable()
    {
        provOff = false;
        if (!Filter) { var g0 = Dxgi; return EnableTraceEx2(session, ref g0, 1, 5, 0, 0, 0, IntPtr.Zero); }
        short[] ev = { 42, 55 };
        IntPtr ids = Marshal.AllocHGlobal(4 + 2 * ev.Length), fd = Marshal.AllocHGlobal(16), parms = Marshal.AllocHGlobal(48);
        try
        {
            Marshal.WriteByte(ids, 0, 1); Marshal.WriteByte(ids, 1, 0); Marshal.WriteInt16(ids, 2, (short)ev.Length);   // EVENT_FILTER_EVENT_ID: FilterIn, Count, Events
            for (int i = 0; i < ev.Length; i++) Marshal.WriteInt16(ids, 4 + 2 * i, ev[i]);
            Marshal.WriteInt64(fd, 0, ids.ToInt64()); Marshal.WriteInt32(fd, 8, 4 + 2 * ev.Length); Marshal.WriteInt32(fd, 12, unchecked((int)0x80000200));   // EVENT_FILTER_TYPE_EVENT_ID
            for (int i = 0; i < 48; i += 4) Marshal.WriteInt32(parms, i, 0);
            Marshal.WriteInt32(parms, 0, 2); Marshal.WriteInt32(parms, 4, 0x10); Marshal.WriteIntPtr(parms, 32, fd); Marshal.WriteInt32(parms, 40, 1);   // ENABLE_TRACE_PARAMETERS v2, IGNORE_KEYWORD_0, one filter
            var g = Dxgi;
            if (EnableTraceEx2(session, ref g, 1 /*EVENT_CONTROL_CODE_ENABLE_PROVIDER*/, 5, 0, 0, 0, parms) == 0) return 0;
        }
        finally { Marshal.FreeHGlobal(parms); Marshal.FreeHGlobal(fd); Marshal.FreeHGlobal(ids); }
        var g2 = Dxgi; return EnableTraceEx2(session, ref g2, 1, 5, 0, 0, 0, IntPtr.Zero);
    }
    // (tests: how many of the game's presents it holds between two QPC times)
    public int CountIn(long a, long b) { lock (lk) { int n = 0; for (int i = 1; i <= count; i++) { long t = ring[(head - i + ring.Length) % ring.Length]; if (t >= a && t <= b) n++; } return n; } }
    // the game's fps a second held within 3% (or 2 frames) over the last StableSecs seconds (its median), as a cap holds it
    public const int StableSecs = 30;
    public bool Stable;
    readonly Queue<double> rates = new Queue<double>(); int stablePid;
    public static bool StableRate(IEnumerable<double> rs)
    {
        var x = rs.Where(r => r > 0).OrderBy(r => r).ToList();
        if (x.Count < StableSecs) return false;
        double med = x[x.Count / 2];
        return x[x.Count - 1] - x[0] <= Math.Max(0.03 * med, 2);   // (a cap's count a second goes a frame or two either way)
    }
    // the pace of the game's frames, for the bottleneck (11-03): true when something holds it (an fps cap, vsync, Reflex),
    // false when it goes up and down, null when there is nothing to tell by. The 5 s before the newest present cut into
    // 10 slices of 0.5 s, each slice's rate from the time its frames span (no +-1 frame of counting noise, a frame's own
    // jitter averages out: a driver limiter can swing 30% frame to frame and still hold its rate); held: 8 of the 10
    // within 2% of the second highest (one fast slice let go, dips under a cap allowed). Nothing to tell by: the newest
    // present over 1 s old, fewer than 8 slices with 3 frames (a load, an alt-tab, under 5 s in front), a top under 20 fps
    public const int PaceSlices = 10, PaceNeed = 8; public const double PaceBand = 0.02;
    public bool? Steady;                    // this second's (null: no game, not counted, or nothing to tell by)
    public static bool? Pace(List<long> ts, long now, long f)
    {
        if (ts.Count < PaceNeed * 3 || f <= 0) return null;
        if (now - ts[ts.Count - 1] > f) return null;
        var rate = Slices(ts, f, PaceSlices).Where(r => !double.IsNaN(r)).ToList();
        if (rate.Count < PaceNeed) return null;
        rate.Sort();
        double top = rate[rate.Count - 2];
        if (top < 20) return null;
        return rate.Count(r => r >= top * (1 - PaceBand)) >= PaceNeed;
    }
    // the 5 s before the newest present in k slices, each one's rate (fps) from the time its frames span (NaN: under 3)
    static List<double> Slices(List<long> ts, long f, int k)
    {
        long last = ts[ts.Count - 1], from = last - 5 * f;
        var rate = new List<double>(k);
        int i = 0; while (i < ts.Count && ts[i] <= from) i++;
        for (int j = 0; j < k; j++)
        {
            long end = j == k - 1 ? last : from + (j + 1) * (5 * f) / k;
            long a = 0, b = 0; int n = 0;
            for (; i < ts.Count && ts[i] <= end; i++) { if (n == 0) a = ts[i]; b = ts[i]; n++; }
            rate.Add(n >= 3 && b > a ? (n - 1) * (double)f / (b - a) : double.NaN);
        }
        return rate;
    }
    // the pace in numbers, to tune Pace from real games (settings "paceLog", see DeckForm.PaceLog): the 10 slices' rates;
    // the frame times' spread (cv) and lag-1 correlation (ac1: near -0.5 for frames held to a clock with jitter, 0 or more
    // for frames that each take their own time); q, how much more 0.125 s slices spread than 0.5 s ones (about 4 held to a
    // clock, 2 or less not). null: under 30 frames
    public bool LogPace; public string PaceLine;   // (asked for, and this second's)
    public static string PaceText(List<long> ts, long f)
    {
        if (ts.Count < 30) return null;
        var inv = System.Globalization.CultureInfo.InvariantCulture;
        long from = ts[ts.Count - 1] - 5 * f;
        var d = new List<double>(); for (int i = 1; i < ts.Count; i++) if (ts[i - 1] >= from) { double g = (ts[i] - ts[i - 1]) * 1000.0 / f; if (g < 1000) d.Add(g); }
        if (d.Count < 3) return null;
        double m = d.Average(), v = d.Sum(x => (x - m) * (x - m)), c = 0; for (int i = 1; i < d.Count; i++) c += (d[i] - m) * (d[i - 1] - m);
        Func<List<double>, double> rsd = r => { var x = r.Where(y => !double.IsNaN(y)).ToList(); if (x.Count < 3) return double.NaN; double a = x.Average(); return Math.Sqrt(x.Sum(y => (y - a) * (y - a)) / (x.Count - 1)) / a; };
        var h = Slices(ts, f, 10); double q = rsd(Slices(ts, f, 40)) / rsd(h);
        return "fps " + (1000 / m).ToString("0.0", inv) + "  slices " + string.Join(",", h.Select(r => double.IsNaN(r) ? "-" : r.ToString("0.0", inv))) +
            "  cv " + (Math.Sqrt(v / d.Count) / m).ToString("0.0000", inv) + "  ac1 " + (v > 0 ? c / v : double.NaN).ToString("0.000", inv) + "  q " + q.ToString("0.00", inv);
    }
}

// what each reading did, for every reading (so a cell added now already has its past): the last 15 min at 1 s,
// 24 h of 1-minute averages and peaks, 7 days of 10-minute averages and peaks, a year of hourly averages and peaks
// (2.4.2: the popup's 30d, 90d and All). The minutes and blocks are saved to hist.bin, the hours to hist-h.bin.
// All readings are sampled together, so which second / minute / block a ring slot holds is one array for all.
class History
{
    public const int SecLen = 900, MinLen = 1440, TenLen = 1008, HourLen = 8784;   // (hours: 366 days)
    class Track
    {
        public float[] Sec = NaNs(SecLen), MAvg = NaNs(MinLen), MMax = NaNs(MinLen), TAvg = NaNs(TenLen), TMax = NaNs(TenLen);
        public float[] HAvg, HMax;   // (made when its first hour is: most readings never need a year of slots)
        public double MSum, MPeak = double.MinValue, TSum, TPeak = double.MinValue, HSum, HPeak = double.MinValue; public int MCnt, TCnt, HCnt;
        public bool Share;   // 1 or 0 a second (the bottleneck's calls): a minute holds its part of the whole minute, not of the seconds sampled
        public double MVal(int len) { return Share ? MSum / len : MSum / MCnt; }
        public double TVal(int len) { return Share ? TSum / len : TSum / TCnt; }
        public double HVal(int len) { return Share ? HSum / Math.Max(len, HCnt) : HSum / HCnt; }   // (a clock set back inside the hour counts its seconds twice: a share never over the whole, 11-07 audit)
        public void Hours() { if (HAvg == null) { HAvg = NaNs(HourLen); HMax = NaNs(HourLen); } }
    }
    readonly Dictionary<string, Track> tracks = new Dictionary<string, Track>();
    readonly long[] secAt = new long[SecLen];
    readonly int[] minAt = new int[MinLen], tenAt = new int[TenLen], hourAt = new int[HourLen];
    Track[] byIndex = new Track[0];
    bool[] own = new bool[0];   // (by index: HW Deck's own fps, frame time and game time, which need no HWiNFO)
    static readonly HashSet<string> OwnKeys = new HashSet<string> { Frames.FpsKey, Frames.LowKey, Frames.FtKey, DeckSource.GameTimeKey, Net.DownKey, Net.UpKey };
    int version = -1, curMin = -1, curTen = -1, curHour = -1;
    readonly string path;
    public History(string dir)
    {
        path = Path.Combine(dir, "hist.bin"); jpath = Path.Combine(dir, "hist.jrn"); hpath = Path.Combine(dir, "hist-h.bin"); hjpath = Path.Combine(dir, "hist-h.jrn");
        for (int i = 0; i < MinLen; i++) minAt[i] = -1;
        for (int i = 0; i < TenLen; i++) tenAt[i] = -1;
        for (int i = 0; i < HourLen; i++) hourAt[i] = -1;
        Load();
        LoadHours();
        long now = Source.Unix(); jMin = (int)(now / 60) - 1; jTen = (int)(now / 600) - 1; jHour = (int)(now / 3600) - 1;   // (what is closed from here on is new)
    }

    // ---- the hours (2.4.2): hist-h.bin, written whole with hist.bin (once a day and at exit), and hist-h.jrn, the hours
    // closed since, a chunk at a time as hist.jrn's. Each: magic, then per reading its key and (hour, average, peak)s.
    // hist-h.bin ends with the sums of the hour in progress at an exit, so a restart within that hour goes on adding ----
    const int HMagic = 0x31525548, HJMagic = 0x314A5548;   // "HUR1", "HUJ1"
    readonly string hpath, hjpath;
    int jHour;
    bool hHeld;   // hist-h.bin couldn't be opened (held by a backup or a scan): nothing saved over it until it is read
    int hTries; long hRetryAt; bool hJrnRead, hSeeded, hSeedLater, hMerge;
    readonly HashSet<int> hSeedAt = new HashSet<int>();   // (the hours the seed filled: a file read later replaces them)
    volatile bool hjFailed;   // a journal write failed: the next save writes hist-h.bin whole
    static void WriteHours(BinaryWriter w, string key, int[] at, float[] avg, float[] max, Func<int, bool> take)
    {
        int n = 0; for (int k = 0; k < HourLen; k++) if (take(at[k]) && !float.IsNaN(avg[k])) n++;
        w.Write(key); w.Write(n);
        for (int k = 0; k < HourLen; k++) if (take(at[k]) && !float.IsNaN(avg[k])) { w.Write(at[k]); w.Write(avg[k]); w.Write(max[k]); }
    }
    // one reading's hours from a file into the ring (the last year's only); a slot holding another hour is cleared for
    // every reading first (over: the journal's, newer, replace what hist-h.bin had)
    void ReadHours(BinaryReader r, int nowHour, bool over)
    {
        string key = r.ReadString(); int c = r.ReadInt32();
        Track t; if (!tracks.TryGetValue(key, out t)) t = null;
        for (int j = 0; j < c; j++)
        {
            int at = r.ReadInt32(); float a = r.ReadSingle(), m = r.ReadSingle();
            if (at <= nowHour - HourLen || at > nowHour || float.IsNaN(a)) continue;
            if (t == null) tracks[key] = t = new Track();
            PutHour(t, at, a, m, over || hSeedAt.Contains(at));
        }
    }
    void PutHour(Track t, int at, float a, float m, bool over)
    {
        int k = at % HourLen;
        if (hourAt[k] != at) { foreach (var o in tracks.Values) if (o.HAvg != null) { o.HAvg[k] = float.NaN; o.HMax[k] = float.NaN; } hourAt[k] = at; }
        t.Hours();
        if (over || float.IsNaN(t.HAvg[k])) { t.HAvg[k] = a; t.HMax[k] = m; }
    }
    // (retry: a minute later, while it was held; what this run measured since stays, the file fills what it lacks)
    void LoadHours(bool retry = false)
    {
        long now = Source.Unix(); int nowHour = (int)(now / 3600);
        bool binRead = false;
        if (File.Exists(hpath))
        {
            FileStream fs = null;
            try { fs = new FileStream(hpath, FileMode.Open, FileAccess.Read, FileShare.Read); }
            catch
            {
                if (++hTries < 10) { hHeld = true; hRetryAt = now + 60; }
                else { hHeld = false; try { File.Move(hpath, hpath + ".held-" + DateTime.Now.ToString("yyyyMMdd-HHmmss", System.Globalization.CultureInfo.InvariantCulture)); } catch { hHeld = true; hRetryAt = now + 60; } }   // (still held after 10 tries: set aside, as hist.bin)
            }
            if (fs != null)
                try
                {
                    hHeld = false;
                    using (var r = new BinaryReader(fs))
                    {
                        if (r.ReadInt32() != HMagic) throw new InvalidDataException("not an hours file");
                        int n = r.ReadInt32();
                        for (int i = 0; i < n; i++) ReadHours(r, nowHour, false);
                        if (r.BaseStream.Position + 12 <= r.BaseStream.Length && r.ReadInt32() == 0x4E45504F)   // "OPEN": the hour in progress at the exit
                        {
                            int oHour = r.ReadInt32(), c = r.ReadInt32();
                            for (int i = 0; i < c; i++)
                            {
                                string key = r.ReadString(); double cnt = r.ReadDouble(), sum = r.ReadDouble(), peak = r.ReadDouble();
                                Track t;
                                if (!retry && oHour == nowHour && tracks.TryGetValue(key, out t)) { t.HCnt += (int)cnt; t.HSum += sum; t.HPeak = Math.Max(t.HPeak, peak); }
                            }
                            if (!retry && oHour == nowHour) curHour = nowHour;
                        }
                    }
                    binRead = true;
                }
                catch
                {
                    fs.Dispose();
                    try { File.Move(hpath, hpath + ".bad-" + DateTime.Now.ToString("yyyyMMdd-HHmmss", System.Globalization.CultureInfo.InvariantCulture)); } catch { hHeld = true; hRetryAt = now + 60; }
                }
        }
        if (!hJrnRead && File.Exists(hjpath))
            try
            {
                using (var fs = new FileStream(hjpath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                using (var r = new BinaryReader(fs))
                    while (fs.Length - fs.Position >= 8)
                    {
                        if (r.ReadInt32() != HJMagic) break;
                        int len = r.ReadInt32();
                        if (len < 4 || fs.Length - fs.Position < len) break;
                        using (var cr = new BinaryReader(new MemoryStream(r.ReadBytes(len))))
                        { int n = cr.ReadInt32(); for (int i = 0; i < n; i++) ReadHours(cr, nowHour, true); }
                    }
            }
            catch { }   // (a damaged chunk: the ones before it count)
        hJrnRead = true;
        // no hist-h.bin read (the first start with hours, or one lost or held): the week of 10-minute blocks into the hours
        // that have nothing (the journal's and this run's stay), written whole at the next save, so a crash before the
        // day's full save loses none of it. hist.bin still held: once it is read
        if (!binRead && !hSeeded) { if (held) hSeedLater = true; else SeedNow(nowHour); }
    }
    void SeedNow(int nowHour) { hSeeded = true; hSeedLater = false; SeedHours(nowHour); HadJournal = true; }
    // the first start with hours: each closed hour of the 7 days of 10-minute blocks (and the minutes of the hours the
    // blocks don't hold) becomes an hour's average and peak
    void SeedHours(int nowHour)
    {
        foreach (var t in tracks.Values)
        {
            var acc = new Dictionary<int, double[]>();   // hour: sum, count, peak
            bool blocks = true;
            for (int k = 0; k < TenLen; k++)
            {
                int bl = tenAt[k]; if (bl < 0 || float.IsNaN(t.TAvg[k])) continue;
                int h = bl / 6; if (h >= nowHour || h <= nowHour - HourLen) continue;
                double[] a; if (!acc.TryGetValue(h, out a)) acc[h] = a = new double[] { 0, 0, double.MinValue };
                a[0] += t.TAvg[k]; a[1]++; if (!float.IsNaN(t.TMax[k]) && t.TMax[k] > a[2]) a[2] = t.TMax[k];
            }
            if (acc.Count == 0) blocks = false;
            if (acc.Count == 0)   // (no blocks: from the minutes, a day's worth)
                for (int k = 0; k < MinLen; k++)
                {
                    int m = minAt[k]; if (m < 0 || float.IsNaN(t.MAvg[k])) continue;
                    int h = m / 60; if (h >= nowHour || h <= nowHour - HourLen) continue;
                    double[] a; if (!acc.TryGetValue(h, out a)) acc[h] = a = new double[] { 0, 0, double.MinValue };
                    a[0] += t.MAvg[k]; a[1]++; if (!float.IsNaN(t.MMax[k]) && t.MMax[k] > a[2]) a[2] = t.MMax[k];
                }
            // (a share, the bottleneck's calls: its part of the whole hour, the blocks or minutes nothing ran in counted as none)
            foreach (var kv in acc) { double a = t.Share ? kv.Value[0] / (blocks ? 6 : 60) : kv.Value[0] / kv.Value[1]; PutHour(t, kv.Key, (float)a, kv.Value[2] > double.MinValue ? (float)kv.Value[2] : (float)a, false); hSeedAt.Add(kv.Key); }
        }
    }
    bool HasHours(Track t) { if (t.HAvg == null) return false; for (int k = 0; k < HourLen; k++) if (hourAt[k] > curHour - HourLen && !float.IsNaN(t.HAvg[k])) return true; return false; }
    // the hours closed since the last write, on the end of hist-h.jrn (every 15 min with hist.jrn's chunk; an hour closes
    // once an hour, so most of these write nothing)
    void JournalHours()
    {
        if (hjFailed) { hjFailed = false; HadJournal = true; }   // (the last write failed: the next save is whole)
        int toHour = curHour - 1;
        if (hHeld || toHour <= jHour) return;
        var ms = new MemoryStream(); var w = new BinaryWriter(ms); int n = 0; w.Write(0);
        int from = Math.Max(jHour, toHour - HourLen);
        foreach (var kv in tracks)   // (only the hours closed since, slot by slot)
        {
            var t = kv.Value; if (t.HAvg == null) continue;
            int c = 0; for (int h = from + 1; h <= toHour; h++) { int k = h % HourLen; if (hourAt[k] == h && !float.IsNaN(t.HAvg[k])) c++; }
            if (c == 0) continue;
            n++; w.Write(kv.Key); w.Write(c);
            for (int h = from + 1; h <= toHour; h++) { int k = h % HourLen; if (hourAt[k] == h && !float.IsNaN(t.HAvg[k])) { w.Write(h); w.Write(t.HAvg[k]); w.Write(t.HMax[k]); } }
        }
        jHour = toHour;
        if (n == 0) return;
        w.Flush(); var b = ms.ToArray(); BitConverter.GetBytes(n).CopyTo(b, 0);
        System.Threading.ThreadPool.QueueUserWorkItem(delegate   // (off the window's thread, as hist.jrn's chunk)
        {
            try
            {
                using (var fs = new FileStream(hjpath, FileMode.Append, FileAccess.Write, FileShare.Read))
                {
                    var h = new byte[8]; BitConverter.GetBytes(HJMagic).CopyTo(h, 0); BitConverter.GetBytes(b.Length).CopyTo(h, 4);
                    fs.Write(h, 0, 8); fs.Write(b, 0, b.Length); fs.Flush(true);
                }
            }
            catch { hjFailed = true; }
        });
    }

    // ---- the journal (2.1, the perf review 11-04): every 15 min only the minutes and 10-minute blocks closed since the
    // last write go on the end of hist.jrn (tens of KB, not the whole hist.bin's MBs every time); hist.bin is written
    // whole once a day and at exit, and then the journal goes. Load reads hist.bin, then the journal's chunks on top;
    // a chunk cut short by a crash is left out (each starts with its length), the ones before it count ----
    const int JMagic = 0x314E524A;   // "JRN1"
    readonly string jpath;
    int jMin, jTen;          // the newest minute and block already written (to hist.bin or the journal)
    volatile bool jFailed;   // a journal write failed: the next one is a whole save instead
    public bool HadJournal;  // the last load found one (the next save writes hist.bin whole, and it goes)
    public bool Journal()
    {
        if (held || saving || curMin < 0) return false;
        JournalHours();
        int toMin = curMin - 1, toTen = curTen - 1;
        if (jFailed || toMin < jMin - 1) { jFailed = false; Save(false); return false; }   // (or the clock set back: whole)
        if (toMin <= jMin && toTen <= jTen) return false;
        var ms = new MemoryStream(); var w = new BinaryWriter(ms); int n = 0; w.Write(0);
        foreach (var kv in tracks)
        {
            var t = kv.Value; int cm = 0, ct = 0;
            for (int k = 0; k < MinLen; k++) if (minAt[k] > jMin && minAt[k] <= toMin && !float.IsNaN(t.MAvg[k])) cm++;
            for (int k = 0; k < TenLen; k++) if (tenAt[k] > jTen && tenAt[k] <= toTen && !float.IsNaN(t.TAvg[k])) ct++;
            if (cm == 0 && ct == 0) continue;
            n++; w.Write(kv.Key);
            w.Write(cm); for (int k = 0; k < MinLen; k++) if (minAt[k] > jMin && minAt[k] <= toMin && !float.IsNaN(t.MAvg[k])) { w.Write(minAt[k]); w.Write(t.MAvg[k]); w.Write(t.MMax[k]); }
            w.Write(ct); for (int k = 0; k < TenLen; k++) if (tenAt[k] > jTen && tenAt[k] <= toTen && !float.IsNaN(t.TAvg[k])) { w.Write(tenAt[k]); w.Write(t.TAvg[k]); w.Write(t.TMax[k]); }
        }
        jMin = Math.Max(jMin, toMin); jTen = Math.Max(jTen, toTen);
        if (n == 0) return false;
        w.Flush(); var b = ms.ToArray(); BitConverter.GetBytes(n).CopyTo(b, 0);
        saving = true;
        System.Threading.ThreadPool.QueueUserWorkItem(delegate
        {
            try
            {
                using (var fs = new FileStream(jpath, FileMode.Append, FileAccess.Write, FileShare.Read))
                {
                    var h = new byte[8]; BitConverter.GetBytes(JMagic).CopyTo(h, 0); BitConverter.GetBytes(b.Length).CopyTo(h, 4);
                    fs.Write(h, 0, 8); fs.Write(b, 0, b.Length); fs.Flush(true);
                }
            }
            catch { jFailed = true; }
            finally { saving = false; }
        });
        return true;
    }
    // one reading's minutes and blocks as hist.bin and the journal keep them, into this history (the last week's only)
    // (over: from the journal, newer than hist.bin: its minute or block replaces one hist.bin had, a partial one written
    // at an exit, 11-06)
    void ReadTrack(BinaryReader r, int nowMin, int nowTen, bool over = false)
    {
        string key = r.ReadString();
        Track t; if (!tracks.TryGetValue(key, out t)) t = new Track();   // a later try adds to what this run measured
        bool any = false;
        int c = r.ReadInt32();
        for (int j = 0; j < c; j++)
        {
            int at = r.ReadInt32(); float a = r.ReadSingle(), m = r.ReadSingle();
            if (at > nowMin - MinLen && at <= nowMin) { int k = at % MinLen; if (over || minAt[k] != at || float.IsNaN(t.MAvg[k])) { t.MAvg[k] = a; t.MMax[k] = m; } minAt[k] = at; any = true; }
        }
        c = r.ReadInt32();
        for (int j = 0; j < c; j++)
        {
            int at = r.ReadInt32(); float a = r.ReadSingle(), m = r.ReadSingle();
            if (at > nowTen - TenLen && at <= nowTen) { int k = at % TenLen; if (over || tenAt[k] != at || float.IsNaN(t.TAvg[k])) { t.TAvg[k] = a; t.TMax[k] = m; } tenAt[k] = at; any = true; }
        }
        if (any) tracks[key] = t;
    }
    void LoadJournal()
    {
        if (!File.Exists(jpath)) return;
        HadJournal = true;
        try
        {
            long now = Source.Unix(); int nowMin = (int)(now / 60), nowTen = (int)(now / 600);
            using (var fs = new FileStream(jpath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            using (var r = new BinaryReader(fs))
                while (fs.Length - fs.Position >= 8)
                {
                    if (r.ReadInt32() != JMagic) break;
                    int len = r.ReadInt32();
                    if (len < 4 || fs.Length - fs.Position < len) break;
                    using (var cr = new BinaryReader(new MemoryStream(r.ReadBytes(len))))
                    { int n = cr.ReadInt32(); for (int i = 0; i < n; i++) ReadTrack(cr, nowMin, nowTen, true); }
                }
        }
        catch { }   // (a damaged chunk: the ones before it count)
    }
    // (tests: a closed minute put in by hand, read back; whether a write is under way)
    public void TestMinute(string key, int at, float avg, float max) { Track t; if (!tracks.TryGetValue(key, out t)) tracks[key] = t = new Track(); int k = at % MinLen; t.MAvg[k] = avg; t.MMax[k] = max; minAt[k] = at; curMin = Math.Max(curMin, at + 1); curTen = Math.Max(curTen, (at + 1) / 10); }
    public float TestRead(string key, int at) { Track t; int k = at % MinLen; return tracks.TryGetValue(key, out t) && minAt[k] == at ? t.MAvg[k] : float.NaN; }
    public bool Busy { get { return saving; } }
    public void TestFrom(int min) { jMin = min; jTen = min / 10; }

    static float[] NaNs(int n) { var a = new float[n]; for (int i = 0; i < n; i++) a[i] = float.NaN; return a; }

    // once a second; moreKeys / more: readings only the history keeps (not in the catalog), NaN for none
    public void Sample(Source src, string[] moreKeys = null, double[] more = null)
    {
        if (held && (Source.Unix() >= retryAt || retryAt - Source.Unix() > 60)) Load();   // (or the clock set back)
        if (hHeld && (Source.Unix() >= hRetryAt || hRetryAt - Source.Unix() > 60)) LoadHours(true);
        if (moreKeys != null) foreach (var k in moreKeys) { Track t; if (!tracks.TryGetValue(k, out t)) tracks[k] = t = new Track(); t.Share = true; }
        if (src.Version != version)
        {
            version = src.Version;
            byIndex = new Track[src.Readings.Count]; own = new bool[src.Readings.Count];
            for (int i = 0; i < own.Length; i++) own[i] = OwnKeys.Contains(src.Readings[i].Key);
            for (int i = 0; i < byIndex.Length; i++)
            {
                Track t;
                if (!tracks.TryGetValue(src.Readings[i].Key, out t)) { t = new Track(); tracks[src.Readings[i].Key] = t; }
                byIndex[i] = t;
            }
        }
        long now = Source.Unix();
        int si = (int)(now % SecLen), minute = (int)(now / 60), ten = (int)(now / 600), hour = (int)(now / 3600);
        // (the clock set back a little: the seconds lived again go into the minute and block in progress, not over an older
        // one; set back further: what was in progress is dropped, the slots go on from the new clock)
        bool bigBack = curMin >= 0 && curMin - minute > 5;
        if (minute != curMin && (minute > curMin || curMin < 0 || bigBack))
        {
            foreach (var t in tracks.Values) { if (bigBack) { t.MSum = 0; t.MCnt = 0; t.MPeak = double.MinValue; } else CloseMin(t); }
            if (curMin >= 0 && !bigBack) minAt[curMin % MinLen] = curMin; curMin = minute;
        }
        if (ten != curTen && (ten > curTen || curTen < 0 || bigBack))
        {
            foreach (var t in tracks.Values) { if (bigBack) { t.TSum = 0; t.TCnt = 0; t.TPeak = double.MinValue; } else CloseTen(t); }
            if (curTen >= 0 && !bigBack) tenAt[curTen % TenLen] = curTen; curTen = ten;
        }
        if (hour != curHour && (hour > curHour || curHour < 0 || bigBack))
        {
            if (curHour >= 0 && !bigBack) { int k = curHour % HourLen; if (hourAt[k] != curHour) { foreach (var o in tracks.Values) if (o.HAvg != null) { o.HAvg[k] = float.NaN; o.HMax[k] = float.NaN; } hourAt[k] = curHour; } }
            foreach (var t in tracks.Values) { if (bigBack) { t.HSum = 0; t.HCnt = 0; t.HPeak = double.MinValue; } else CloseHour(t); }
            curHour = hour; hMerge = bigBack && hourAt[hour % HourLen] == hour;   // (the clock set back into an hour already kept: it only fills what that hour lacks)
        }
        // (set back within the hour: its seconds are kept, counted twice, its peak with them; HVal keeps a share at most the whole, 11-07 audit)
        foreach (var t in tracks.Values) t.Sec[si] = float.NaN;
        bool hwOk = src.Status == "ok";
        for (int i = 0; i < byIndex.Length && i < src.Values.Length; i++)
        {
            if (!hwOk && (i >= own.Length || !own[i])) continue;   // (HWiNFO away: only HW Deck's own fps, frame time and game time go in, 11-07 audit)
            double v = src.Values[i];
            if (double.IsNaN(v) || double.IsInfinity(v)) continue;
            var t = byIndex[i];
            t.Sec[si] = (float)v;
            t.MSum += v; t.MCnt++; if (v > t.MPeak) t.MPeak = v;
            t.TSum += v; t.TCnt++; if (v > t.TPeak) t.TPeak = v;
            t.HSum += v; t.HCnt++; if (v > t.HPeak) t.HPeak = v;
        }
        if (src.Status == "ok" && moreKeys != null && more != null)
            for (int i = 0; i < moreKeys.Length && i < more.Length; i++)
            {
                double v = more[i];
                if (double.IsNaN(v) || double.IsInfinity(v)) continue;
                var t = tracks[moreKeys[i]];
                t.Sec[si] = (float)v;
                t.MSum += v; t.MCnt++; if (v > t.MPeak) t.MPeak = v;
                t.TSum += v; t.TCnt++; if (v > t.TPeak) t.TPeak = v;
                t.HSum += v; t.HCnt++; if (v > t.HPeak) t.HPeak = v;
            }
        secAt[si] = now;
    }

    void CloseMin(Track t)
    {
        if (curMin >= 0) { int k = curMin % MinLen; t.MAvg[k] = t.MCnt > 0 ? (float)t.MVal(60) : float.NaN; t.MMax[k] = t.MCnt > 0 ? (float)t.MPeak : float.NaN; }
        t.MSum = 0; t.MCnt = 0; t.MPeak = double.MinValue;
    }
    // (the slot's hour is set before this: every reading gets this hour's value, NaN where nothing was measured)
    void CloseHour(Track t)
    {
        if (curHour >= 0)
        {
            int k = curHour % HourLen;
            if (t.HCnt > 0) { t.Hours(); if (hMerge && !float.IsNaN(t.HAvg[k])) t.HMax[k] = Math.Max(t.HMax[k], (float)t.HPeak); else { t.HAvg[k] = (float)t.HVal(3600); t.HMax[k] = (float)t.HPeak; } }
            else if (t.HAvg != null && !hMerge) { t.HAvg[k] = float.NaN; t.HMax[k] = float.NaN; }
        }
        t.HSum = 0; t.HCnt = 0; t.HPeak = double.MinValue;
    }
    void CloseTen(Track t)
    {
        if (curTen >= 0) { int k = curTen % TenLen; t.TAvg[k] = t.TCnt > 0 ? (float)t.TVal(600) : float.NaN; t.TMax[k] = t.TCnt > 0 ? (float)t.TPeak : float.NaN; }
        t.TSum = 0; t.TCnt = 0; t.TPeak = double.MinValue;
    }

    static object R(double v) { return double.IsNaN(v) || double.IsInfinity(v) ? null : (object)Math.Round(v, 3); }

    // history from elsewhere (a build moving its old history over, see Extra): one reading's closed minutes as unix
    // minute, average, peak. They fill the 24 h of minutes and, ten at a time, the 7 days of blocks, but only where
    // this history has nothing for that reading yet; a slot still holding an older minute (or block) is cleared for
    // every reading first. Returns how many minutes went in
    public int Import(string key, IList<int> minutes, IList<float> avg, IList<float> peak)
    {
        Track t;
        if (!tracks.TryGetValue(key, out t)) { t = new Track(); tracks[key] = t; }
        long now = Source.Unix();
        int cm = curMin >= 0 ? curMin : (int)(now / 60), ct = curTen >= 0 ? curTen : (int)(now / 600), n = 0;
        var blocks = new Dictionary<int, double[]>();   // block: sum of averages, count, peak
        for (int i = 0; i < minutes.Count && i < avg.Count && i < peak.Count; i++)
        {
            int m = minutes[i];
            if (m >= cm || float.IsNaN(avg[i])) continue;
            if (m > cm - MinLen)
            {
                int k = m % MinLen;
                if (minAt[k] != m) { foreach (var o in tracks.Values) { o.MAvg[k] = float.NaN; o.MMax[k] = float.NaN; } minAt[k] = m; }
                if (float.IsNaN(t.MAvg[k])) { t.MAvg[k] = avg[i]; t.MMax[k] = peak[i]; n++; }
            }
            double[] b;
            if (!blocks.TryGetValue(m / 10, out b)) blocks[m / 10] = b = new double[] { 0, 0, double.MinValue };
            b[0] += avg[i]; b[1]++; if (!float.IsNaN(peak[i]) && peak[i] > b[2]) b[2] = peak[i];
        }
        foreach (var kv in blocks)
        {
            int bl = kv.Key;
            if (bl >= ct || bl <= ct - TenLen) continue;
            int k = bl % TenLen;
            if (tenAt[k] != bl) { foreach (var o in tracks.Values) { o.TAvg[k] = float.NaN; o.TMax[k] = float.NaN; } tenAt[k] = bl; }
            if (float.IsNaN(t.TAvg[k])) { t.TAvg[k] = (float)(kv.Value[0] / kv.Value[1]); t.TMax[k] = kv.Value[2] > double.MinValue ? (float)kv.Value[2] : t.TAvg[k]; }
        }
        return n;
    }

    // the last 15 min, oldest first, ending at the second `now`; null where nothing was measured
    public object[] Seconds(string key, long now)
    {
        Track t;
        var a = new object[SecLen];
        if (!tracks.TryGetValue(key, out t)) return a;
        for (int i = 0; i < SecLen; i++)
        {
            long s = now - SecLen + 1 + i; int k = (int)(s % SecLen);
            if (secAt[k] == s) a[i] = R(t.Sec[k]);
        }
        return a;
    }

    // when a reading last had a value (unix s): the newest of its seconds, minutes, blocks and hours kept, or now while
    // the minute, block or hour in progress has one; 0 when the history has none (11-08: a reading in the layout that
    // HWiNFO doesn't share and that had no value for 7 days is taken as gone, Re-link back; less is a pause)
    public long LastAt(string key, long now)
    {
        Track t;
        if (!tracks.TryGetValue(key, out t)) return 0;
        if (t.MCnt > 0 || t.TCnt > 0 || t.HCnt > 0) return now;
        long best = 0;
        for (int k = 0; k < SecLen; k++) if (secAt[k] > best && !float.IsNaN(t.Sec[k])) best = secAt[k];
        for (int k = 0; k < MinLen; k++) if (minAt[k] >= 0 && !float.IsNaN(t.MAvg[k])) best = Math.Max(best, (minAt[k] + 1) * 60L);
        for (int k = 0; k < TenLen; k++) if (tenAt[k] >= 0 && !float.IsNaN(t.TAvg[k])) best = Math.Max(best, (tenAt[k] + 1) * 600L);
        if (t.HAvg != null) for (int k = 0; k < HourLen; k++) if (hourAt[k] >= 0 && !float.IsNaN(t.HAvg[k])) best = Math.Max(best, (hourAt[k] + 1) * 3600L);
        return Math.Min(best, now);
    }
    // the oldest time the history holds anything for (unix s; now when it holds nothing yet)
    public long Since(long now)
    {
        long s = now;
        for (int k = 0; k < MinLen; k++) if (minAt[k] >= 0) s = Math.Min(s, minAt[k] * 60L);
        for (int k = 0; k < TenLen; k++) if (tenAt[k] >= 0) s = Math.Min(s, tenAt[k] * 600L);
        for (int k = 0; k < HourLen; k++) if (hourAt[k] >= 0) s = Math.Min(s, hourAt[k] * 3600L);
        return s;
    }

    // 1 h, 6 h, 12 h, 24 h as 1-minute points, 1 to 7 days ("3d") as 10-minute points, 30 days, 90 days and all of the
    // year kept ("all": from its first hour) as hourly points; oldest first, averages and peaks
    public Dictionary<string, object> Range(string key, string range)
    {
        if (range == "30d" || range == "90d" || range == "all") return Hours(key, range);
        int nd = range != null && range.Length == 2 && range[1] == 'd' && range[0] >= '1' && range[0] <= '7' ? range[0] - '0' : 0;
        bool week = nd > 0;
        int span = week ? nd * (TenLen / 7) : range == "1h" ? 60 : range == "6h" ? 360 : range == "12h" ? 720 : 1440;
        var avg = new object[span]; var max = new object[span];
        Track t;
        if (tracks.TryGetValue(key, out t))
        {
            int cur = week ? curTen : curMin;
            for (int i = 0; i < span; i++)
            {
                int b = cur - span + 1 + i;
                if (b == cur)
                {
                    int c = week ? t.TCnt : t.MCnt;
                    if (c > 0) { avg[i] = R(week ? t.TVal(600) : t.MVal(60)); max[i] = R(week ? t.TPeak : t.MPeak); }
                }
                else if (b >= 0)
                {
                    int k = week ? b % TenLen : b % MinLen;
                    if ((week ? tenAt[k] : minAt[k]) == b) { avg[i] = R(week ? t.TAvg[k] : t.MAvg[k]); max[i] = R(week ? t.TMax[k] : t.MMax[k]); }
                }
            }
        }
        return new Dictionary<string, object> { { "key", key }, { "range", week ? nd + "d" : range }, { "step", week ? 600 : 60 }, { "span", span * (week ? 600 : 60) }, { "avg", avg }, { "max", max }, { "end", (long)(week ? curTen : curMin) * (week ? 600 : 60) } };   // end: where the last column starts
    }

    Dictionary<string, object> Hours(string key, string range)
    {
        Track t; tracks.TryGetValue(key, out t);
        int cur = curHour >= 0 ? curHour : (int)(Source.Unix() / 3600), span = range == "30d" ? 720 : range == "90d" ? 2160 : 0;
        if (span == 0)   // all: from its oldest hour (a week at least, so a new install still has room)
        {
            int first = cur;
            if (t != null && t.HAvg != null) for (int k = 0; k < HourLen; k++) if (hourAt[k] > cur - HourLen && hourAt[k] < first && !float.IsNaN(t.HAvg[k])) first = hourAt[k];
            span = Math.Max(168, cur - first + 1);
        }
        var avg = new object[span]; var max = new object[span];
        if (t != null)
            for (int i = 0; i < span; i++)
            {
                int b = cur - span + 1 + i;
                if (b == cur) { if (t.HCnt > 0) { avg[i] = R(t.HVal(3600)); max[i] = R(t.HPeak); } }
                else if (b >= 0 && t.HAvg != null) { int k = b % HourLen; if (hourAt[k] == b) { avg[i] = R(t.HAvg[k]); max[i] = R(t.HMax[k]); } }
            }
        return new Dictionary<string, object> { { "key", key }, { "range", range }, { "step", 3600 }, { "span", span * 3600 }, { "avg", avg }, { "max", max }, { "end", (long)cur * 3600 } };
    }

    // a copy of what is closed (cheap, on the UI thread); the writing happens on a pool thread unless the app is quitting
    class Snap { public string Key; public float[] MAvg, MMax, TAvg, TMax; }
    volatile bool saving;
    public void Save(bool wait)
    {
        if (held) return;   // the old file couldn't be read yet: never saved over
        if (saving && !wait) return;
        for (int i = 0; i < 200 && saving; i++) System.Threading.Thread.Sleep(25);   // quitting: let a running save finish first
        var ma = (int[])minAt.Clone(); var ta = (int[])tenAt.Clone();
        int oldMin = curMin - MinLen, oldTen = curTen - TenLen;
        var list = new List<Snap>(); var dead = new List<string>();
        foreach (var kv in tracks)
        {
            var t = kv.Value;
            bool any = false;
            for (int k = 0; k < MinLen && !any; k++) any = ma[k] > oldMin && !float.IsNaN(t.MAvg[k]);
            for (int k = 0; k < TenLen && !any; k++) any = ta[k] > oldTen && !float.IsNaN(t.TAvg[k]);
            if (!any) { if (!t.Share && Array.IndexOf(byIndex, t) < 0 && !HasHours(t)) dead.Add(kv.Key); continue; }   // nothing in the last week (a drive or adapter that's gone) nor in the year's hours: not kept
            list.Add(new Snap { Key = kv.Key, MAvg = (float[])t.MAvg.Clone(), MMax = (float[])t.MMax.Clone(), TAvg = (float[])t.TAvg.Clone(), TMax = (float[])t.TMax.Clone() });
        }
        // (and not in memory either, when no reading feeds it now: 11-06. Save runs on the tick Sample runs on, so the
        // tracks never change under it)
        foreach (var k in dead) tracks.Remove(k);
        var open = openAcc; int oMin = openMin, oTen = openTen; var sAt = secSnap; var sTr = secTracks;
        int sMin = curMin - 1, sTen = curTen - 1;   // (closed up to here: the journal starts after it)
        // the hours too (a copy of the slots that hold one, from the readings that have any)
        var ha = (int[])hourAt.Clone(); int oldHour = curHour - HourLen, sHour = curHour - 1;
        var hl = new List<Snap>(); bool hWrite = !hHeld;
        if (hWrite) foreach (var kv in tracks) if (kv.Value.HAvg != null && HasHours(kv.Value)) hl.Add(new Snap { Key = kv.Key, TAvg = (float[])kv.Value.HAvg.Clone(), TMax = (float[])kv.Value.HMax.Clone() });
        var hOpen = openH; int oHour = openHour;
        System.Threading.ThreadStart write = delegate
        {
            try
            {
                string tmp = path + ".tmp";
                using (var fs = new FileStream(tmp, FileMode.Create, FileAccess.Write, FileShare.None, 1 << 16))
                using (var w = new BinaryWriter(fs))
                {
                    w.Write(0x4B444857); w.Write(2); w.Write(list.Count);
                    foreach (var t in list)
                    {
                        w.Write(t.Key);
                        int n = 0; for (int k = 0; k < MinLen; k++) if (ma[k] >= 0 && !float.IsNaN(t.MAvg[k])) n++;
                        w.Write(n); for (int k = 0; k < MinLen; k++) if (ma[k] >= 0 && !float.IsNaN(t.MAvg[k])) { w.Write(ma[k]); w.Write(t.MAvg[k]); w.Write(t.MMax[k]); }
                        n = 0; for (int k = 0; k < TenLen; k++) if (ta[k] >= 0 && !float.IsNaN(t.TAvg[k])) n++;
                        w.Write(n); for (int k = 0; k < TenLen; k++) if (ta[k] >= 0 && !float.IsNaN(t.TAvg[k])) { w.Write(ta[k]); w.Write(t.TAvg[k]); w.Write(t.TMax[k]); }
                    }
                    if (open != null)   // after the tracks (older builds stop reading before it): the sums of the blocks in progress
                    {
                        w.Write(0x4E45504F); w.Write(oMin); w.Write(oTen); w.Write(open.Count);
                        foreach (var kv in open) { w.Write(kv.Key); foreach (double d in kv.Value) w.Write(d); }
                        if (sAt != null && sTr != null)   // and the seconds
                        {
                            w.Write(0x53434553); foreach (long t in sAt) w.Write(t); w.Write(sTr.Count);
                            foreach (var kv in sTr) { w.Write(kv.Key); foreach (float x in kv.Value) w.Write(x); }
                        }
                    }
                    w.Flush(); fs.Flush(true);
                }
                if (File.Exists(path)) File.Replace(tmp, path, null); else File.Move(tmp, path);
                try { File.Delete(jpath); } catch { }   // (all it held is in hist.bin now)
                HadJournal = false;
                if (hWrite)   // (as at the snapshot: a retry that frees the file meanwhile must not get an empty one written over it)
                {
                    string htmp = hpath + ".tmp";
                    using (var fs = new FileStream(htmp, FileMode.Create, FileAccess.Write, FileShare.None, 1 << 16))
                    using (var w = new BinaryWriter(fs))
                    {
                        w.Write(HMagic); w.Write(hl.Count);
                        foreach (var t in hl) WriteHours(w, t.Key, ha, t.TAvg, t.TMax, at => at > oldHour);
                        if (hOpen != null) { w.Write(0x4E45504F); w.Write(oHour); w.Write(hOpen.Count); foreach (var kv in hOpen) { w.Write(kv.Key); foreach (double d in kv.Value) w.Write(d); } }
                        w.Flush(); fs.Flush(true);
                    }
                    if (File.Exists(hpath)) File.Replace(htmp, hpath, null); else File.Move(htmp, hpath);
                    try { File.Delete(hjpath); } catch { }
                    if (sHour >= 0) jHour = Math.Max(jHour, sHour);
                }
                if (sMin >= 0) { jMin = Math.Max(jMin, sMin); jTen = Math.Max(jTen, sTen); }
            }
            catch { }
            finally { saving = false; }
        };
        saving = true;
        if (wait) write(); else new System.Threading.Thread(write) { IsBackground = false, Priority = System.Threading.ThreadPriority.BelowNormal }.Start();
    }
    // at exit: the minute and 10-minute block in progress count too, and their sums are kept, so a restart inside
    // the same minute or block goes on adding to them
    Dictionary<string, double[]> openAcc, openH; int openMin = -1, openTen = -1, openHour = -1;
    long[] secSnap; Dictionary<string, float[]> secTracks;
    public void DropOpen() { openAcc = null; openH = null; secSnap = null; secTracks = null; }   // the next saves are ordinary ones again
    public void CloseOpen()
    {
        secSnap = (long[])secAt.Clone(); secTracks = new Dictionary<string, float[]>();
        foreach (var kv in tracks) if (kv.Value.Sec.Any(x => !float.IsNaN(x))) secTracks[kv.Key] = (float[])kv.Value.Sec.Clone();
        openAcc = new Dictionary<string, double[]>(); openMin = curMin; openTen = curTen;
        foreach (var kv in tracks) { var t = kv.Value; if (t.MCnt > 0 || t.TCnt > 0) openAcc[kv.Key] = new[] { t.MCnt, t.MSum, t.MPeak, t.TCnt, t.TSum, t.TPeak }; }
        openH = new Dictionary<string, double[]>(); openHour = curHour;
        foreach (var kv in tracks) { var t = kv.Value; if (t.HCnt > 0) openH[kv.Key] = new[] { (double)t.HCnt, t.HSum, t.HPeak }; }
        if (curHour >= 0)   // (the hour so far into its slot, as the minute and block are; the sums go on)
        {
            int k = curHour % HourLen;
            if (hourAt[k] != curHour) { foreach (var o in tracks.Values) if (o.HAvg != null) { o.HAvg[k] = float.NaN; o.HMax[k] = float.NaN; } hourAt[k] = curHour; }
            foreach (var t in tracks.Values) if (t.HCnt > 0 && !(hMerge && t.HAvg != null && !float.IsNaN(t.HAvg[k]))) { t.Hours(); t.HAvg[k] = (float)t.HVal(3600); t.HMax[k] = (float)t.HPeak; }
        }
        foreach (var t in tracks.Values)   // their values so far; the sums go on, so a cancelled shutdown loses nothing
        {
            // (one with nothing in it gets nothing, as at a minute's end: its slot still holds the same minute a day ago)
            if (curMin >= 0) { int k = curMin % MinLen; t.MAvg[k] = t.MCnt > 0 ? (float)t.MVal(60) : float.NaN; t.MMax[k] = t.MCnt > 0 ? (float)t.MPeak : float.NaN; }
            if (curTen >= 0) { int k = curTen % TenLen; t.TAvg[k] = t.TCnt > 0 ? (float)t.TVal(600) : float.NaN; t.TMax[k] = t.TCnt > 0 ? (float)t.TPeak : float.NaN; }
        }
        if (curMin >= 0) minAt[curMin % MinLen] = curMin;
        if (curTen >= 0) tenAt[curTen % TenLen] = curTen;
    }

    // a hist.bin that can't be opened (a backup or a scan holding it) is tried again a minute later and nothing is
    // saved over it meanwhile; one that is damaged, or still can't be opened after 10 tries, is moved aside as
    // hist.bin.bad-<time> first, and only then does saving start again
    bool held; int tries; long retryAt;
    void Load()
    {
        held = false;
        if (!File.Exists(path)) { LoadJournal(); return; }
        FileStream fs;
        try { fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read); }
        catch
        {
            if (++tries < 10) { held = true; retryAt = Source.Unix() + 60; return; }
            SetAside(); if (held) return;   // (it can't even be moved: tried again later)
            LoadJournal(); if (hSeedLater) SeedNow((int)(Source.Unix() / 3600)); return;   // (moved aside: the journal still goes in, as for a damaged or missing file, 11-07 audit; the next save deleted it unread)
        }
        try
        {
            long now = Source.Unix(); int nowMin = (int)(now / 60), nowTen = (int)(now / 600);
            using (var r = new BinaryReader(fs))
            {
                if (r.ReadInt32() != 0x4B444857 || r.ReadInt32() != 2) throw new InvalidDataException("not a history file");
                int n = r.ReadInt32();
                for (int i = 0; i < n; i++) ReadTrack(r, nowMin, nowTen);
                if (r.BaseStream.Position + 16 <= r.BaseStream.Length && r.ReadInt32() == 0x4E45504F)
                {
                    int oMin = r.ReadInt32(), oTen = r.ReadInt32(), c = r.ReadInt32();
                    for (int i = 0; i < c; i++)
                    {
                        string key = r.ReadString(); var d = new double[6]; for (int j = 0; j < 6; j++) d[j] = r.ReadDouble();
                        Track t;
                        if (!tracks.TryGetValue(key, out t)) continue;
                        if (oMin == nowMin) { t.MCnt += (int)d[0]; t.MSum += d[1]; t.MPeak = Math.Max(t.MPeak, d[2]); }
                        if (oTen == nowTen) { t.TCnt += (int)d[3]; t.TSum += d[4]; t.TPeak = Math.Max(t.TPeak, d[5]); }
                    }
                    if (oMin == nowMin) curMin = nowMin;
                    if (oTen == nowTen) curTen = nowTen;
                    if (r.BaseStream.Position + 4 <= r.BaseStream.Length && r.ReadInt32() == 0x53434553)
                    {
                        var at = new long[SecLen]; for (int i = 0; i < SecLen; i++) at[i] = r.ReadInt64();
                        int c2 = r.ReadInt32();
                        bool recent = at.Max() > now - SecLen;
                        if (recent) for (int i = 0; i < SecLen; i++) if (at[i] > now - SecLen && at[i] <= now) secAt[i] = at[i];
                        for (int i = 0; i < c2; i++)
                        {
                            string key = r.ReadString(); var sec = new float[SecLen]; for (int j = 0; j < SecLen; j++) sec[j] = r.ReadSingle();
                            Track t;
                            if (recent && tracks.TryGetValue(key, out t)) for (int j = 0; j < SecLen; j++) if (secAt[j] == at[j] && at[j] > now - SecLen) t.Sec[j] = sec[j];
                        }
                    }
                }
            }
        }
        catch { fs.Dispose(); SetAside(); }
        LoadJournal();   // (on top: what was closed after hist.bin was last written whole)
        if (hSeedLater && !held) SeedNow((int)(Source.Unix() / 3600));   // (the hours' seed waited for it)
    }
    void SetAside()
    {
        try { File.Move(path, path + ".bad-" + DateTime.Now.ToString("yyyyMMdd-HHmmss", System.Globalization.CultureInfo.InvariantCulture)); }
        catch { held = true; retryAt = Source.Unix() + 60; }   // can't even move it: kept as it is, tried again later
    }
}

// the warning log: every cell with gates (or a fan curve) in the working layout is checked once a second, even
// while the window is hidden. A line when it turns yellow or red, when it escalates, and when it has been back
// to normal for 3 s (with its peak), in alerts.log, the same format as the tailored dashboard
class Alerts
{
    class Rule { public string Id, Key, Name, Unit, Mode, Dir, Src; public double Y, R, Tol, Hold, CurveHold, OY = double.NaN, OR = double.NaN; public bool CurveWarn = true; public int Dec; public double[][] Pts; public Func<int> Level; public Func<string> Why; }
    class St
    {
        public long Since; public int Logged, Calm, Dec; public double Peak, PeakDev; public string Name, Unit; public bool Below, Off;
        public string PeakTxt { get { return Txt(Peak, Dec, Unit); } }
    }
    List<Rule> rules = new List<Rule>();
    readonly Dictionary<string, St> state = new Dictionary<string, St>();
    public readonly List<string> Lines = new List<string>();
    public int NewAlerts;                     // counted by the game report
    // every episode past its line this second with its worst value so far (New: it just turned or escalated), for
    // the game report's list of what crossed a line
    public class Warm { public string Name, Unit; public double Peak; public bool New, Below; }
    public readonly List<Warm> Hot = new List<Warm>();
    public HashSet<string> Skip = new HashSet<string>();   // readings with no verdict right now (PresentMon away from the game)
    public bool SkipHold;   // (the game still runs, in the background: an open warning of a skipped reading waits; no game: it ends)
    // lines a build keeps whatever the layout holds (see Extra): its own checks in the warning log, as cell-like entries
    // { key, name, gates }, judged like a cell's; their ids start "x:"
    public readonly Dictionary<string, IDictionary<string, object>> Always = new Dictionary<string, IDictionary<string, object>>();
    // rules judged by code instead of by lines: the level now (0, 1 yellow, 2 red) and why (added to the log line), the
    // reading whose value the log shows. HW Deck's own: a 12V-2x6 connector cell's uneven pins; a build adds its own
    public class Judged { public string Key = null, Name = null, Unit = null; public double Hold = 0; public Func<int> Level = null; public Func<string> Why = null; }
    public readonly Dictionary<string, Judged> Own = new Dictionary<string, Judged>();
    public Connector Conn;

    public static double Num(object o, double d) { try { double v = o == null ? d : Convert.ToDouble(o, System.Globalization.CultureInfo.InvariantCulture); return double.IsInfinity(v) ? d : v; } catch { return d; } }
    static object F(IDictionary<string, object> d, string k) { object o; return d != null && d.TryGetValue(k, out o) ? o : null; }
    // the page's default decimals per unit (decFor in deck.js), so the log says what the cell showed
    public static int DecFor(string u)
    {
        u = u ?? "";
        if (u == "V") return 3; if (u == "A" || u == "x") return 2;
        if (u.IndexOf('°') >= 0 || u == "W" || u == "ms" || u == "GT/s" || u == "GB" || u == "MB" || u == "MB/s" || u == "KB/s" || u == "GB/s") return 1;   // (MB is shown in GB)
        return 0;
    }
    // the short name the page gives a sensor (shortName in deck.js), to tell apart cells with the same name
    static string ShortName(string n)
    {
        string s = Regex.Replace(Regex.Replace(n ?? "", @"\s*\[#\d+\]", ""), @"\s*\[[A-Z]:\]\s*$", "");
        s = Regex.Replace(s, @"\s*\([^)]*\)\s*$", "");
        var parts = s.Split(new[] { ": " }, StringSplitOptions.RemoveEmptyEntries).Select(x => x.Trim()).Where(x => x.Length > 0).ToArray();
        if (parts.Length > 1 && Regex.IsMatch(parts[0], @"^(S\.M\.A\.R\.T\.|Drive)$", RegexOptions.IgnoreCase)) return Regex.Replace(parts[1], @"\s*\([^)]*\)", "").Trim();
        return parts.Length > 0 ? parts[0] : n;
    }
    static string Clean(string s) { return Regex.Replace(s ?? "", @"[\x00-\x1f\x7f]+", " ").Trim(); }

    // the page's working layout (state.json's L)
    public void SetLayout(object layout, Source src)
    {
        var list = new List<Rule>();
        string connId = null; IDictionary<string, object> connC = null;   // (the first 12V-2x6 connector cell: its pins are watched, lines or not)
        var cells = F(layout as IDictionary<string, object>, "cells") as IDictionary<string, object>;
        var all = cells != null ? cells.ToList() : new List<KeyValuePair<string, object>>();
        foreach (var kv in Always) all.Add(new KeyValuePair<string, object>("x:" + kv.Key, kv.Value));
        foreach (var kv in all)
        {
            var c = kv.Value as IDictionary<string, object>;
            string key = F(c, "key") as string;
            if (c == null || key == null || true.Equals(F(c, "pred")) || key == Bottleneck.Key) continue;   // a call, not a level: no lines
            var g = F(c, "gates") as IDictionary<string, object>;
            var cv = F(c, "curve") as IDictionary<string, object>;
            string mode = g != null ? F(g, "mode") as string : null;
            bool gated = mode == "y" || mode == "yr";
            if (key == Connector.Key && connId == null && !kv.Key.StartsWith("x:")) { connId = kv.Key; connC = c; }
            if (!gated && cv == null) continue;
            var rd = src.Readings.FirstOrDefault(x => x.Key == key);
            string name = Clean(F(c, "name") as string);
            var rule = new Rule { Id = kv.Key, Key = key, Name = name.Length > 0 ? name : (rd != null ? Clean(rd.Label) : key), Unit = rd != null ? rd.Unit : "",
                                  Mode = gated ? mode : "none", Dir = g != null && "below".Equals(F(g, "dir")) ? "below" : "above",
                                  Y = gated ? Num(F(g, "y"), double.NaN) : double.NaN, R = mode == "yr" ? Num(F(g, "r"), double.NaN) : double.NaN,
                                  Hold = gated ? Math.Max(0, Math.Min(1e9, Num(F(g, "hold"), 0))) : 0 };
            rule.Dec = (int)Math.Max(0, Math.Min(3, Num(F(c, "dec"), DecFor(rule.Unit))));
            // lines on the other side too (gates.other: y and/or r, past its own yellow the other way, red further than yellow)
            var og = gated ? F(g, "other") as IDictionary<string, object> : null;
            if (og != null && !double.IsNaN(rule.Y))
            {
                bool down = rule.Dir != "below";
                double oy = Num(F(og, "y"), double.NaN), orr = Num(F(og, "r"), double.NaN);
                Func<double, bool> beyond = x => double.IsNaN(x) || (down ? x < rule.Y : x > rule.Y);
                bool ok = !(double.IsNaN(oy) && double.IsNaN(orr)) && beyond(oy) && beyond(orr) && (double.IsNaN(oy) || double.IsNaN(orr) || (down ? orr <= oy : orr >= oy));
                if (ok) { rule.OY = oy; rule.OR = orr; }
            }
            if (cv != null)
            {
                rule.Src = F(cv, "src") as string; rule.Tol = Math.Max(1, Num(F(cv, "tol"), 15)); rule.CurveHold = Math.Max(0, Math.Min(1e9, Num(F(cv, "hold"), 10)));
                rule.CurveWarn = !false.Equals(F(cv, "warn"));   // off: the page only says how far off it is, nothing is logged
                var pts = F(cv, "pts") as System.Collections.IList;   // object[] from state.json, ArrayList from a page message
                if (pts != null)
                    rule.Pts = pts.Cast<object>().Select(p => p as System.Collections.IList).Where(p => p != null && p.Count >= 2)
                                  .Select(p => new[] { Num(p[0], double.NaN), Num(p[1], double.NaN) }).Where(p => !double.IsNaN(p[0]) && !double.IsNaN(p[1]))
                                  .OrderBy(p => p[0]).ThenBy(p => p[1]).ToArray();   // by temperature, a tie by rpm (a step)
                if (rule.Pts == null || rule.Pts.Length < 2) rule.Pts = null;
            }
            list.Add(rule);
        }
        // a build's always-on lines (x:) step aside while a cell's lines watch the same reading the same way: the cell
        // says it once (its lines are the ones you set); without such a cell, or with lines that can't judge (no
        // yellow, red on the wrong side), they come back. A build's judged rules (Own, below) always stay: they
        // say something no line can. (11-06: before the names below, so a cell doesn't keep a suffix from a rule
        // that is gone, and the log still finds its cell)
        Func<Rule, bool> judges = x => (x.Mode == "y" || x.Mode == "yr") && !double.IsNaN(x.Y) && !(x.Mode == "yr" && !double.IsNaN(x.R) && (x.Dir == "below" ? x.R >= x.Y : x.R <= x.Y));
        var watched = new HashSet<string>(list.Where(x => !x.Id.StartsWith("x:") && judges(x)).Select(x => x.Key + "|" + x.Dir));
        list.RemoveAll(x => x.Id.StartsWith("x:") && watched.Contains(x.Key + "|" + x.Dir));
        // the history pairs lines by name: cells with the same name get their sensor's name, then a number
        foreach (var grp in list.GroupBy(r => r.Name).Where(x => x.Count() > 1).ToList())
        {
            foreach (var r in grp)
            {
                var rd = src.Readings.FirstOrDefault(x => x.Key == r.Key);
                if (rd != null && rd.Sensor >= 0 && rd.Sensor < src.Sensors.Count) r.Name += " (" + Clean(ShortName(src.Sensors[rd.Sensor].Name)) + ")";
            }
        }
        foreach (var grp in list.GroupBy(r => r.Name).Where(x => x.Count() > 1).ToList()) { int n = 1; foreach (var r in grp.Skip(1)) r.Name += " #" + (++n); }
        // a 12V-2x6 connector cell also watches its pins' balance: once, whatever else watches the connector (a build's
        // own rule, a second cell), under its own name so its episodes don't mix with the cell's
        foreach (var r in list.Where(x => x.Key == Connector.Key && x.Level == null).OrderBy(x => x.Id.StartsWith("x:") ? 1 : 0).Take(1).ToList())
            list.Add(new Rule { Id = r.Id + ":uneven", Key = r.Key, Name = r.Name + " pins", Unit = r.Unit, Dec = 2, Mode = "none", Hold = 3,
                                Level = () => Conn != null && Conn.Lopsided ? 1 : 0,
                                Why = () => Conn == null ? "" : " (pin " + (Conn.Hot + 1) + " carrying " + Math.Round(Conn.Share, 1).ToString(System.Globalization.CultureInfo.InvariantCulture) + "x its share)" });
        // (a connector cell with no lines still watches its pins, as on the page: the rule comes from the cell itself)
        if (connId != null && !list.Any(x => x.Key == Connector.Key && x.Level != null))
        {
            var rd = src.Readings.FirstOrDefault(x => x.Key == Connector.Key);
            string nm = Clean(F(connC, "name") as string); if (nm.Length == 0) nm = rd != null ? Clean(rd.Label) : Connector.Key;
            list.Add(new Rule { Id = connId + ":uneven", Key = Connector.Key, Name = nm + " pins", Unit = rd != null ? rd.Unit : "", Dec = 2, Mode = "none", Hold = 3,
                                Level = () => Conn != null && Conn.Lopsided ? 1 : 0,
                                Why = () => Conn == null ? "" : " (pin " + (Conn.Hot + 1) + " carrying " + Math.Round(Conn.Share, 1).ToString(System.Globalization.CultureInfo.InvariantCulture) + "x its share)" });
        }
        foreach (var kv in Own)
        {
            var j = kv.Value;
            list.Add(new Rule { Id = "o:" + kv.Key, Key = j.Key, Name = j.Name, Unit = j.Unit ?? "", Dec = DecFor(j.Unit), Mode = "none", Hold = j.Hold, Level = j.Level, Why = j.Why });
        }
        rules = list;
        // an episode whose line is gone (cell removed, gates off, another layout loaded) ends here, not at the next start
        foreach (var id in state.Keys.Where(k => !rules.Any(r => r.Id == k)).ToList())
        {
            var s = state[id];
            if (s.Logged > 0 && s.Name != null) Lines.Add(string.Format("{0}  OK      {1}: back to normal (line removed, peak {2})", AppInfo.Stamp(), s.Name, s.PeakTxt));
            state.Remove(id);
        }
    }

    // HWiNFO stopped sharing (or the app quits): no more verdicts, open episodes end at this line. Each gets a PEAK
    // line first: with no OK line the page would only know the value it crossed at
    public void Mark(string why)
    {
        foreach (var s in state.Values) if (s.Logged > 0 && s.Name != null) Lines.Add(string.Format("{0}  PEAK    {1}: {2}", AppInfo.Stamp(), s.Name, s.PeakTxt));
        Lines.Add(AppInfo.Stamp() + "  MARK    " + why);
        state.Clear();
    }

    static double Interp(double[][] p, double x)
    {
        if (p == null || p.Length == 0) return double.NaN;
        if (x <= p[0][0]) return p[0][1];
        for (int i = 1; i < p.Length; i++) if (x <= p[i][0]) return p[i - 1][1] + (p[i][1] - p[i - 1][1]) * (x - p[i - 1][0]) / Math.Max(1e-9, p[i][0] - p[i - 1][0]);
        return p[p.Length - 1][1];
    }

    long lastNow;
    public void Tick(Source src, Dictionary<string, int> index)
    {
        if (src.Status != "ok") return;   // no readings, no verdicts (the host marks a longer outage)
        long now = Source.Unix();
        // the clock set back (a time sync): a hold keeps the time it has run
        if (lastNow - now > 1) foreach (var st in state.Values) if (st.Since > 0) st.Since += now - lastNow;
        lastNow = now;
        foreach (var r in rules)
        {
            int i;
            if (r.Key == null || !index.TryGetValue(r.Key, out i) || i >= src.Values.Length || double.IsNaN(src.Values[i]))
            {
                // its reading went away mid-episode (a drive unplugged, a sensor gone): the episode ends like a calm one
                St g;
                if (state.TryGetValue(r.Id, out g) && g.Logged == 0) g.Since = 0;   // (one still in its hold starts it again)
                else if (g != null && g.Logged > 0)
                {
                    g.Since = 0;   // (like a calm second: its hold starts again, as on the page)
                    if (++g.Calm >= 3)
                    {
                        Lines.Add(string.Format("{0}  OK      {1}: back to normal (reading gone, peak {2})", AppInfo.Stamp(), g.Name, g.PeakTxt));
                        g.Logged = 0; g.Calm = 0; g.Name = null; g.Since = 0;
                    }
                }
                continue;
            }
            double v = src.Values[i];
            int raw = 0; double hold = r.Hold, dev = 0; bool off = false, under = false, other = false; string extra = "";
            bool skip = Skip.Contains(r.Key);
            // (11-06: a skipped reading, PresentMon away while the game is in the back, has no verdict: an open episode
            // waits as it is instead of ending "back to normal" and counting again on return; a hold starts again)
            if (skip && SkipHold) { St k; if (state.TryGetValue(r.Id, out k) && k.Logged == 0) k.Since = 0; continue; }   // (11-07 audit: with the game closed it ends "back to normal" after 3 s, as before 11-06)
            if (r.Level != null && !skip) { raw = Math.Max(0, Math.Min(2, r.Level())); if (raw > 0 && r.Why != null) extra = r.Why(); }
            bool gatesOk = !skip && r.Mode != "none" && !double.IsNaN(r.Y) && !(r.Mode == "yr" && !double.IsNaN(r.R) && (r.Dir == "below" ? r.R >= r.Y : r.R <= r.Y));
            if (gatesOk)
            {
                Func<double, bool> past = x => r.Dir == "below" ? v <= x : v >= x;
                if (r.Mode == "yr" && !double.IsNaN(r.R) && past(r.R)) raw = 2; else if (past(r.Y)) raw = 1;
                else
                {
                    Func<double, bool> po = x => !double.IsNaN(x) && (r.Dir != "below" ? v <= x : v >= x);
                    if (po(r.OR)) { raw = 2; other = true; } else if (po(r.OY)) { raw = 1; other = true; }
                }
            }
            int si;
            if (!skip && raw == 0 && r.CurveWarn && r.Pts != null && r.Pts.Length > 0 && r.Src != null && index.TryGetValue(r.Src, out si) && si < src.Values.Length && !double.IsNaN(src.Values[si]))
            {
                double exp = Interp(r.Pts, src.Values[si]);
                double pct = exp > 0 ? (v - exp) / exp * 100 : v > 100 ? 100 : 0;   // (11-06: expected at 0 rpm and spinning: off it, as on the page)
                if (Math.Abs(pct) > r.Tol)
                {
                    raw = 1; hold = r.CurveHold; off = true; under = v < exp; dev = Math.Abs(pct) / 100;
                    extra = " (" + Math.Abs(Math.Round(pct)).ToString(System.Globalization.CultureInfo.InvariantCulture) + "% " + (v < exp ? "under" : "over") + " its curve)";
                }
            }
            St s;
            if (!state.TryGetValue(r.Id, out s)) { s = new St(); state[r.Id] = s; }
            if (raw > 0) { if (s.Since == 0 || s.Since > now) s.Since = now; } else s.Since = 0;   // (the clock set back: the hold counts from the step)
            // an episode already open goes on at its level while the value is past a line, even when a calm second
            // restarted the hold (only a new episode waits for the hold; a step up to red inside one that has lasted it
            // counts at once): a value hovering on its line is one episode, not OK and YELLOW over and over
            int lvl = raw > 0 ? (now - s.Since >= hold ? raw : s.Logged > 0 ? Math.Min(raw, s.Logged) : 0) : 0;
            if (lvl > 0)
            {
                s.Calm = 0;
                if (s.Logged == 0) s.Off = off;
                // the worst moment: furthest past the line, or furthest off the curve
                if (s.Logged == 0) s.Below = !off && (r.Dir == "below") != other;   // which way this episode is bad
                // (a cell with lines and a curve stays one episode across the two; its peak is of the kind it started as)
                bool worse = off == s.Off && (off ? dev > s.PeakDev : s.Below ? v < s.Peak : v > s.Peak);
                if (s.Logged == 0 || worse) { s.Peak = v; s.PeakDev = dev; s.Unit = r.Unit; s.Dec = r.Dec; }
                if (s.Logged == 0) s.Name = r.Name + (off ? " fan curve" : "");   // one name for the whole episode
                bool fresh = s.Logged != lvl && (s.Logged == 0 || lvl > s.Logged);
                if (fresh)
                {
                    // (a line that warns below says so: the history's peak for it is the lowest value, not the highest)
                    Lines.Add(string.Format("{0}  {1,-7} {2}: {3}{4}{5}", AppInfo.Stamp(), lvl == 2 ? "RED" : "YELLOW", s.Name, Txt(v, r.Dec, r.Unit), s.Below && !off ? " (under its line)" : "", extra));
                    NewAlerts++;
                }
                if (lvl > s.Logged) s.Logged = lvl;
                bool mb = r.Unit == "MB";   // (memory in GB, like everywhere)
                Hot.Add(new Warm { Name = s.Name, Unit = mb ? "GB" : r.Unit, Peak = Math.Round(mb ? s.Peak / 1024 : s.Peak, Math.Max(mb ? 1 : 0, Math.Min(3, s.Dec))), New = fresh, Below = off ? under : s.Below });
            }
            else if (s.Logged > 0 && raw == 0)
            {
                if (++s.Calm >= 3)
                {
                    Lines.Add(string.Format("{0}  OK      {1}: back to normal (peak {2})", AppInfo.Stamp(), s.Name, s.PeakTxt));
                    s.Logged = 0; s.Calm = 0; s.Name = null;
                }
            }
        }
    }
    static string Fmt(double v, int dec) { return Math.Round(v, Math.Max(0, Math.Min(3, dec))).ToString(System.Globalization.CultureInfo.InvariantCulture); }
    // a value with its unit as the page shows it: memory (MB) in GB
    static string Txt(double v, int dec, string unit) { return unit == "MB" ? Fmt(v / 1024, Math.Max(1, dec)) + " GB" : (Fmt(v, dec) + " " + (unit ?? "")).Trim(); }
}

// where games are installed: Steam libraries (and the non-Steam shortcuts), Epic, Riot, Blizzard, EA, GOG, Ubisoft,
// Rockstar and Xbox
static class GameRoots
{
    // launchers, browsers and media apps added to Steam for its controller support, by their whole names (a game added
    // through its own launcher.exe sits in the folder that holds the game, and Mirror's Edge is a game)
    static readonly Regex NotAShortcutApp = new Regex(@"^(EA( app| Desktop)?|Origin|Steam|Battle\.net|Blizzard Battle\.net|GOG Galaxy( 2(\.0)?)?|Playnite|Heroic( Games Launcher)?|Ubisoft Connect|Uplay|Riot Client|Epic Games( Launcher| Store)?|Rockstar Games Launcher|Amazon Games|HoYoPlay|(Microsoft )?Edge|(Google )?Chrome|(Mozilla )?Firefox|Opera( GX)?|Brave|Vivaldi|Discord|Spotify|Netflix|YouTube|Twitch|Plex( HTPC| Media Player)?|Kodi|VLC( media player)?|Xbox( app)?|(Logitech )?G HUB|LGHUB)$", RegexOptions.IgnoreCase);
    static readonly Regex NotAShortcutExe = new Regex(@"^(riotclient\w*|battle\.net( launcher)?|eadesktop|origin|galaxyclient|playnite\.\w+|heroic|upc|ubisoftconnect|epicgameslauncher|rockstar\w*launcher|amazon games( ui)?|hyp|lghub(_\w+)?|steam|msedge|chrome|firefox|opera|brave|vivaldi|discord|spotify|vlc|kodi|plex( ?media ?(player|server)| ?htpc)?|netflix|twitch|xboxpcapp)$", RegexOptions.IgnoreCase);
    static readonly Regex NotAGame = new Regex(@"Wallpaper.?Engine|SteamVR|OVR.?Advanced|Steamworks|Redistributable|Proton|Steam Linux Runtime|Steam Controller|Soundpad|Lossless Scaling|Bongo.?Cat|VTube.?Studio|OBS.?Studio|Blender|DisplayFusion|Fences|Desktop.?Mate|Godot|Aseprite|Krita|Voicemod|FPS.?Monitor|Unreal.?Engine|Twinmotion|RealityCapture|RealityScan|MetaHuman", RegexOptions.IgnoreCase);

    static string Norm(string dir)
    {
        try { return Path.GetFullPath(dir.Trim().Trim('"').Replace('/', '\\')).TrimEnd('\\').ToLowerInvariant() + "\\"; }
        catch { return null; }
    }
    static void Add(List<KeyValuePair<string, string>> roots, string dir, string name)
    {
        if (string.IsNullOrEmpty(dir) || string.IsNullOrEmpty(name) || NotAGame.IsMatch(name)) return;
        string n = Norm(dir);
        if (n == null || n.Length <= 3 || !Directory.Exists(n)) return;   // never a whole drive
        // nor anything in Windows (a Steam shortcut to cmd, PowerShell or the on-screen keyboard would make System32 a
        // game: Task Manager in front would start a session), nor a whole Program Files, profile, Desktop, Documents or
        // Downloads folder (a shortcut to a .lnk on the Desktop)
        string win = Norm(Environment.GetFolderPath(Environment.SpecialFolder.Windows));
        if (win != null && win.Length > 3 && n.StartsWith(win)) return;
        foreach (var sys in new[] { Environment.SpecialFolder.ProgramFiles, Environment.SpecialFolder.ProgramFilesX86, Environment.SpecialFolder.UserProfile, Environment.SpecialFolder.DesktopDirectory,
                                    Environment.SpecialFolder.CommonDesktopDirectory, Environment.SpecialFolder.MyDocuments })
            if (n == Norm(Environment.GetFolderPath(sys))) return;
        if (n == Norm(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads"))) return;
        roots.Add(new KeyValuePair<string, string>(n, name.Replace("\u00AE", "").Replace("\u2122", "").Trim()));
    }

    // every subkey of an HKLM key
    static string ReadShared(string f) { using (var rd = new StreamReader(new FileStream(f, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))) return rd.ReadToEnd(); }   // (Steam may be writing it)
    static void Each(string key, Action<Microsoft.Win32.RegistryKey> f)
    {
        try
        {
            using (var k = Microsoft.Win32.Registry.LocalMachine.OpenSubKey(key))
                if (k != null) foreach (var sub in k.GetSubKeyNames()) try { using (var e = k.OpenSubKey(sub)) if (e != null) f(e); } catch { }
        }
        catch { }
    }

    public static List<KeyValuePair<string, string>> Build()
    {
        var roots = new List<KeyValuePair<string, string>>();
        string steam = null;
        try { using (var k = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(@"Software\Valve\Steam")) if (k != null) steam = k.GetValue("SteamPath") as string; } catch { }
        if (steam != null)
        {
            steam = steam.Replace('/', '\\');
            var libs = new List<string> { steam };
            try
            {
                foreach (Match m in Regex.Matches(ReadShared(Path.Combine(steam, @"steamapps\libraryfolders.vdf")), "\"path\"\\s+\"(.+?)\""))
                    libs.Add(m.Groups[1].Value.Replace("\\\\", "\\"));
            }
            catch { }
            foreach (var lib in libs)
            {
                try
                {
                    foreach (var acf in Directory.GetFiles(Path.Combine(lib, "steamapps"), "appmanifest_*.acf"))
                        try   // (one manifest being written by Steam right now skips only itself)
                        {
                            string t; using (var rd = new StreamReader(new FileStream(acf, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))) t = rd.ReadToEnd();   // (Steam may be writing it)
                            var dir = Regex.Match(t, "\"installdir\"\\s+\"(.+?)\"");
                            var name = Regex.Match(t, "\"name\"\\s+\"(.+?)\"");
                            if (dir.Success && name.Success) Add(roots, Path.Combine(lib, @"steamapps\common", dir.Groups[1].Value), name.Groups[1].Value);
                        }
                        catch { }
                    foreach (var d in Directory.GetDirectories(Path.Combine(lib, @"steamapps\common")))
                    {
                        string n = Norm(d);
                        if (n != null && !roots.Any(r => r.Key == n)) Add(roots, d, Path.GetFileName(d));
                    }
                }
                catch { }
            }
            // non-Steam games added to the library (shortcuts.vdf is binary: \x01key\x00value\x00)
            var cuts = new List<string[]>();   // start folder, name, exe
            try
            {
                foreach (var f in Directory.GetFiles(Path.Combine(steam, "userdata"), "shortcuts.vdf", SearchOption.AllDirectories))
                {
                    string t; try { t = ReadShared(f); } catch { continue; }   // (one account's file being written skips only itself)
                    foreach (Match m in Regex.Matches(t, "\u0001appname\u0000([^\u0000]*)\u0000\u0001exe\u0000([^\u0000]*)\u0000\u0001startdir\u0000([^\u0000]*)\u0000", RegexOptions.IgnoreCase))
                    {
                        // (Steam quotes the target: anything after it is arguments)
                        string exe = m.Groups[2].Value.Trim(), exeName;
                        if (exe.StartsWith("\"")) { int q = exe.IndexOf('"', 1); exe = q > 0 ? exe.Substring(1, q - 1) : exe.Trim('"'); }
                        try { exeName = Path.GetFileNameWithoutExtension(exe); } catch { exeName = ""; }
                        // (a launcher, a browser or a media app added to Steam for its controller support is no game)
                        if (NotAShortcutApp.IsMatch(m.Groups[1].Value.Trim()) || NotAShortcutExe.IsMatch(exeName)) continue;
                        string start = m.Groups[3].Value.Trim().Trim('"');
                        if (start.Length <= 3) { try { start = Path.GetDirectoryName(exe); } catch { start = null; } }
                        cuts.Add(new[] { start, m.Groups[1].Value, exe });
                    }
                }
            }
            catch { }
            // games added through one emulator share its folder, and which one runs can't be told from the process: such
            // a folder goes by the program's name (Dolphin), not by the first game's
            // (one game added twice, "Skyrim" and "Skyrim SKSE", keeps the name the others start with; a script launcher's
            // folder goes by the folder's name)
            foreach (var g in cuts.Where(x => !string.IsNullOrEmpty(x[0])).GroupBy(x => Norm(x[0]) ?? x[0]))
            try
            {
                var names = g.Select(x => x[1].Trim()).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
                string name = names.FirstOrDefault(a => names.All(b => b.StartsWith(a, StringComparison.OrdinalIgnoreCase)));
                if (name == null)
                {
                    // (one program for several games, an emulator: the program's name; script launchers: the folder's, as it
                    // is spelled; a game beside its own tools, a loader or a config exe: the game's)
                    Func<string, string> prog = e => { try { return Path.GetFileNameWithoutExtension(e ?? ""); } catch { return ""; } };
                    Func<string, bool> script = e => Regex.IsMatch(e ?? "", @"\.(bat|cmd|ps1|vbs|js|lnk|url)$", RegexOptions.IgnoreCase) || Regex.IsMatch(prog(e), @"^(cmd|powershell|pwsh|wscript|cscript|explorer)$", RegexOptions.IgnoreCase);
                    var shared = g.Where(x => !script(x[2]) && prog(x[2]) != "").GroupBy(x => prog(x[2]), StringComparer.OrdinalIgnoreCase)
                                  .Where(x => x.Select(y => y[1].Trim()).Distinct(StringComparer.OrdinalIgnoreCase).Count() > 1).OrderByDescending(x => x.Count()).FirstOrDefault();
                    if (shared != null) name = shared.Key;
                    else if (g.All(x => script(x[2]))) name = Path.GetFileName(Path.GetFullPath(g.First()[0].Trim()).TrimEnd('\\'));
                    else name = (g.FirstOrDefault(x => !script(x[2]) && !Regex.IsMatch(prog(x[2]), @"loader|launcher|config|setup|settings|editor|tool", RegexOptions.IgnoreCase)) ?? g.First())[1];
                }
                Add(roots, g.First()[0], name);
            }
            catch { }   // (one odd entry never ends the list)
        }
        try
        {
            var ser = new JavaScriptSerializer();
            string epic = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), @"Epic\EpicGamesLauncher\Data\Manifests");
            foreach (var f in Directory.GetFiles(epic, "*.item"))
                try   // (one manifest that can't be read skips only itself)
                {
                    var j = ser.Deserialize<Dictionary<string, object>>(File.ReadAllText(f));
                    object loc, name, cats, app, main;
                    if (j == null) continue;
                    // (an install that isn't a game, the Unreal editor and its tools, or a DLC, which names its game: none)
                    if (j.TryGetValue("AppCategories", out cats) && cats is System.Collections.IEnumerable && !(cats is string)
                        && !((System.Collections.IEnumerable)cats).Cast<object>().Any(x => "games".Equals(x as string, StringComparison.OrdinalIgnoreCase))) continue;
                    if (j.TryGetValue("MainGameAppName", out main) && main is string && (string)main != "" && j.TryGetValue("AppName", out app) && !string.Equals((string)main, app as string, StringComparison.OrdinalIgnoreCase)) continue;
                    if (j.TryGetValue("InstallLocation", out loc) && j.TryGetValue("DisplayName", out name)) Add(roots, loc as string, name as string);
                }
                catch { }
        }
        catch { }
        var hives = new[] {
            new KeyValuePair<Microsoft.Win32.RegistryKey, string>(Microsoft.Win32.Registry.LocalMachine, @"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
            new KeyValuePair<Microsoft.Win32.RegistryKey, string>(Microsoft.Win32.Registry.LocalMachine, @"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"),
            new KeyValuePair<Microsoft.Win32.RegistryKey, string>(Microsoft.Win32.Registry.CurrentUser, @"Software\Microsoft\Windows\CurrentVersion\Uninstall") };
        var riotParents = new HashSet<string>();
        foreach (var h in hives)
        {
            try
            {
                using (var k = h.Key.OpenSubKey(h.Value))
                {
                    if (k == null) continue;
                    foreach (var sub in k.GetSubKeyNames())
                    {
                        try
                        {
                            using (var e = k.OpenSubKey(sub))
                            {
                                string pub = e.GetValue("Publisher") as string ?? "", name = e.GetValue("DisplayName") as string ?? "", loc = e.GetValue("InstallLocation") as string ?? "";
                                if (!Regex.IsMatch(pub, @"^(Blizzard Entertainment|Riot Games|Electronic Arts|Rockstar Games)") || loc == "") continue;
                                if (pub.StartsWith("Riot"))
                                {
                                    try
                                    {
                                        string parent = Path.GetDirectoryName(loc.Replace('/', '\\').TrimEnd('\\'));
                                        if (parent != null && Path.GetFileName(parent).Equals("Riot Games", StringComparison.OrdinalIgnoreCase)) riotParents.Add(parent);
                                    }
                                    catch { }
                                }
                                if (Regex.IsMatch(name, @"Riot Client|Vanguard|Battle\.net|^EA app|^Origin|Launcher|Social Club", RegexOptions.IgnoreCase)) continue;
                                Add(roots, loc, name);
                            }
                        }
                        catch { }
                    }
                }
            }
            catch { }
        }
        foreach (var parent in riotParents)
        {
            try { foreach (var d in Directory.GetDirectories(parent)) { string n = Path.GetFileName(d); if (!Regex.IsMatch(n, "Riot Client|Vanguard", RegexOptions.IgnoreCase)) Add(roots, d, n); } }
            catch { }
        }
        // GOG Galaxy, Ubisoft Connect and Rockstar list their games in the registry; Xbox / Game Pass installs go to
        // an XboxGames folder on any drive
        foreach (var hk in new[] { @"SOFTWARE\WOW6432Node\GOG.com\Games", @"SOFTWARE\GOG.com\Games" })
            Each(hk, e => { if (string.IsNullOrEmpty(e.GetValue("dependsOn") as string)) Add(roots, e.GetValue("path") as string, e.GetValue("gameName") as string); });   // (a DLC names its game: dependsOn)
        Each(@"SOFTWARE\WOW6432Node\Ubisoft\Launcher\Installs", e => { string d = e.GetValue("InstallDir") as string; if (d != null) Add(roots, d, Path.GetFileName(d.Replace('/', '\\').TrimEnd('\\'))); });
        Each(@"SOFTWARE\WOW6432Node\Rockstar Games", e => { string n = Path.GetFileName(e.Name); if (!Regex.IsMatch(n, "Launcher|Social Club", RegexOptions.IgnoreCase)) Add(roots, e.GetValue("InstallFolder") as string, n); });
        try
        {
            foreach (var dr in DriveInfo.GetDrives())
            {
                if (dr.DriveType != DriveType.Fixed || !dr.IsReady) continue;
                string xg = Path.Combine(dr.RootDirectory.FullName, "XboxGames");
                if (Directory.Exists(xg)) foreach (var d in Directory.GetDirectories(xg)) Add(roots, d, Path.GetFileName(d));
            }
        }
        catch { }
        roots = roots.GroupBy(r => r.Key).Select(g => g.First()).ToList();
        roots.Sort((a, b) => b.Key.Length.CompareTo(a.Key.Length));   // most specific folder wins
        return roots;
    }
}

// processes, read without opening them (works for anti-cheat protected games too)
static class Procs
{
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out int pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern uint QueryDosDevice(string dev, StringBuilder target, int max);
    [DllImport("ntdll.dll")] static extern int NtQuerySystemInformation(int cls, IntPtr info, int len, out int ret);

    public static Dictionary<string, string> Devices()   // \Device\HarddiskVolume3 -> C:
    {
        var d = new Dictionary<string, string>(); var sb = new StringBuilder(260);
        for (char c = 'A'; c <= 'Z'; c++) if (QueryDosDevice(c + ":", sb, sb.Capacity) > 0) d[sb.ToString()] = c + ":";
        return d;
    }
    public static int Foreground() { int fg = 0; try { GetWindowThreadProcessId(GetForegroundWindow(), out fg); } catch { } return fg; }
    // the running processes' ids only (2.1, the perf review 11-04: Process.GetProcesses built an object per process and
    // per thread, ~8,700 of them every 3 s on his PC, only for the ids)
    [DllImport("kernel32.dll")] static extern bool K32EnumProcesses([Out] int[] ids, int size, out int needed);
    static int[] pidBuf = new int[2048];
    public static int[] Pids()
    {
        for (int tries = 0; tries < 6; tries++)
        {
            int need;
            if (!K32EnumProcesses(pidBuf, pidBuf.Length * 4, out need)) break;
            if (need < pidBuf.Length * 4) { var r = new int[need / 4]; Array.Copy(pidBuf, r, r.Length); return r; }
            pidBuf = new int[pidBuf.Length * 2];   // (full: maybe more of them)
        }
        try { return Process.GetProcesses().Select(p => { int id = p.Id; p.Dispose(); return id; }).ToArray(); } catch { return new int[0]; }
    }
    public static string ImagePath(int pid, Dictionary<string, string> devices)
    {
        IntPtr buf = Marshal.AllocHGlobal(1024), info = Marshal.AllocHGlobal(24);
        try
        {
            Marshal.WriteIntPtr(info, 0, new IntPtr(pid)); Marshal.WriteInt16(info, 8, 0); Marshal.WriteInt16(info, 10, 1024); Marshal.WriteIntPtr(info, 16, buf);
            int ret;
            if (NtQuerySystemInformation(88 /*SystemProcessIdInformation*/, info, 24, out ret) != 0) return null;
            string nt = Marshal.PtrToStringUni(buf, Marshal.ReadInt16(info, 8) / 2);
            foreach (var d in devices) if (nt.StartsWith(d.Key + "\\", StringComparison.OrdinalIgnoreCase)) return d.Value + nt.Substring(d.Key.Length);
            return null;
        }
        catch { return null; }
        finally { Marshal.FreeHGlobal(buf); Marshal.FreeHGlobal(info); }
    }
}

// games: which one runs (polled every 3 s on a pool thread), and a report per session in games.log: how long, fps
// and 1% low while it was the window in front (HWiNFO's PresentMon readings), the main temperatures, powers, usages
// and memory, every gated cell of the layout with its lines, what crossed a line, and a minute by minute timeline
class Games
{
    class Report { public long Start, From, Last; public string Game; public int Secs, Front, FpsN, LowN, Warns, Custom; public double FpsSum, LowSum;   // Custom: 1 a session you started
                   // per reading: sum, samples, max, and for VRAM / RAM the most used + available seen (their scale); Names:
                   // its name in the report, its unit, "m" for a main reading
                   public Dictionary<string, double[]> Items = new Dictionary<string, double[]>(); public Dictionary<string, string[]> Names = new Dictionary<string, string[]>();
                   // seconds in front each bottleneck call held (G gpu, C cpu, F capped); per minute since Start, Tb holds the
                   // call that held most of it ('-' none), Tc its seconds per call ([g, c, f], null none), Tf and Tl the fps
                   // and 1% low averages in front (null none). MinAt is the minute in progress, MG, MC, MF its seconds per
                   // call, MFs / MFn and MLs / MLn its fps sums
                   public int G, C, F, MinAt = -1, MG, MC, MF, MFn, MLn; public double MFs, MLs; public string Tb = "";
                   public List<int[]> Tc = new List<int[]>();
                   public List<double?> Tf = new List<double?>(), Tl = new List<double?>();
                   // its breaks: the game closed and started again within Same game again (one session), from and to, unix seconds
                   public List<long[]> Gaps = new List<long[]>();
                   // what crossed a line (up to 5): its name, unit, worst value and which way worse is
                   public List<string> WarnNames = new List<string>(), WarnUnits = new List<string>(); public List<double> WarnPeaks = new List<double>(); public List<bool> WarnBelow = new List<bool>();
                   // the game's own readings (PresentMon's: fps, frame times) while it was in front: min, sum, samples, max
                   public Dictionary<string, double[]> Pm = new Dictionary<string, double[]>();
                   // the lines each reading had during the session (not saved: filled again every second)
                   [ScriptIgnore] public Dictionary<string, Lines> Ln = new Dictionary<string, Lines>(); }
    // a gated cell's lines (NaN: none) and name, for the report
    public class Lines { public double Y = double.NaN, R = double.NaN; public bool Below; public string Name; }
    public HashSet<string> Tracked = new HashSet<string>();   // what the layout's report setup asks for besides (L.games: any reading, by key)
    static readonly Regex NotGameExe = new Regex(@"launcher|leagueclient|crash(report|handler|pad|sender)|report|redist|setup|^unins|helper|anticheat|battleye|beservice|prereq|bootstrap|boot(64)?$|updater|overlay|dxsetup|cefprocess|webhelper|qtwebengine|browser|diagnose|installer|config(64)?$|blizzarderror|capturepro|^upc$|^battle\.net|^eadesktop$|^eabackgroundservice$|^galaxyclient|^riotclient|^playnite|^heroic$|^(msedge|chrome|firefox|opera|brave|vivaldi|discord|steam|hyp|spotify|vlc|kodi|xboxpcapp)$|^plex( ?media ?(player|server)| ?htpc)?$|^lghub(_\w+)?$", RegexOptions.IgnoreCase);
    readonly object lk = new object();
    // (games.log has one writer at a time: the game timer's appends and drops, an edit, a trim, a move to the bin or back)
    public readonly object LogLock = new object();
    readonly Dictionary<int, string> paths = new Dictionary<int, string>();
    HashSet<int> hotPids = new HashSet<int>();   // the last look's processes in a game folder
    Dictionary<string, string> devices;           // the drives' device names (Procs.Devices), looked up every 10 minutes
    readonly HashSet<string> fgSeen = new HashSet<string>();   // programs seen in front outside every game folder
    bool rescan;                                  // look for the game folders again at the next poll
    List<KeyValuePair<string, string>> roots; DateTime rootsAt = DateTime.MinValue;
    System.Threading.Timer timer; int busy, pollNo;
    public string Game; public bool InFront; public long Since, Seen;   // the session (it ends 5 s after the game closes)
    public const int EndAfter = 5;   // (seconds: gone this long, the session ends)
    public volatile int MergeWithin = 1800;   // (seconds: started again within this, it goes on; Settings, Same game again: 30 minutes unless set, 0 never)
    // the session that just ended, kept MergeWithin seconds: the same game started again goes on with it (Reopen)
    Report done; string doneLine; string doneGame; long doneStart, doneEnd;
    public volatile bool LogChanged;   // a line came into games.log or went out of it (the page's open popup gets it again)
    public string GameExe;                  // the exe of the game's process (the one in front if several)
    public volatile int GamePid;            // that process (0: none), whose frames HW Deck counts (Frames)
    long otherSince;                        // since when another game is the one in front
    Report rep;
    // curPath / custPath: where this run saves the session in progress and your own: the main files, or a spare beside
    // them (games.current.2.json, .3) while another program holds one; curUnread / custUnread: files held at the start,
    // read once free; stale: files whose sessions are logged or taken but whose delete failed, tried again
    readonly string logPath, pendPath, curMain, custMain;   // pendPath: session lines games.log refused, until they go in
    string curPath, custPath;
    readonly List<string> curUnread = new List<string>(), custUnread = new List<string>(), stale = new List<string>();
    readonly JavaScriptSerializer json = new JavaScriptSerializer();
    readonly Action<string> log;
    int headVersion = -1; List<string> head = new List<string>();
    volatile bool polled;                   // no verdicts before the first look at the processes
    string resumeGame; long resumeStart, resumeLast;   // a session the last run left open, picked up if its game still runs
    public Games(string dir, Action<string> log)
    {
        logPath = Path.Combine(dir, "games.log"); curPath = curMain = Path.Combine(dir, "games.current.json"); custPath = custMain = Path.Combine(dir, "games.custom.json"); this.log = log;
        pendPath = logPath + ".pending";
        TakePending();
        var read = new List<string>();
        foreach (var f in new[] { curMain, Spare(curMain, 2), Spare(curMain, 3) })
        {
            if (!File.Exists(f)) continue;
            string t = ReadHeld(f);
            if (t == null && File.Exists(f)) { curUnread.Add(f); continue; }
            read.Add(f); rep = Later(rep, Fresh(ParseCur(t)));
        }
        curPath = new[] { curMain, Spare(curMain, 2), Spare(curMain, 3) }.First(f => !curUnread.Contains(f) || f.EndsWith(".3.json"));
        if (curUnread.Count > 0) log(Path.GetFileName(curUnread[0]) + " is held by another program: saving to " + Path.GetFileName(curPath) + " until it is free");
        // (saved first, then the other files go: a crash in between leaves a copy twice, never none)
        // (a session ahead of the clock: the clock is behind since the last run, or was ahead then; either way it is
        // logged at its own times, not moved, and its game, still running, starts a new one)
        if (rep != null && rep.Last - Source.Unix() > 5) { LogLeft(rep); rep = null; }
        if (rep == null || SaveCur()) foreach (var f in read) if (f != curPath || rep == null) Gone(f);
        if (rep != null) { resumeGame = rep.Game; resumeStart = rep.Start; resumeLast = rep.Last; }
        donePath = Path.Combine(dir, "games.done.json"); LoadDone();
        LoadCustom();
        timer = new System.Threading.Timer(delegate { if (System.Threading.Interlocked.Exchange(ref busy, 1) == 1) return; try { Poll(); } catch (Exception ex) { log("games: " + ex.Message); } finally { busy = 0; } }, null, 2500, 3000);
    }
    // a file another program holds for a moment (a sync or backup tool at logon) isn't damage: a few tries; null:
    // still held (or gone)
    static string ReadHeld(string p, int tries = 5)
    {
        for (int i = 0; i < tries; i++)
            try { return File.ReadAllText(p); }
            catch (FileNotFoundException) { return null; }
            catch (DirectoryNotFoundException) { return null; }
            catch (IOException) { if (i + 1 < tries) System.Threading.Thread.Sleep(200); }
            catch (UnauthorizedAccessException) { if (i + 1 < tries) System.Threading.Thread.Sleep(200); }
        return null;
    }
    static string Spare(string p, int n) { return p.Substring(0, p.Length - 5) + "." + n + ".json"; }   // games.current.json: games.current.2.json
    Report ParseCur(string text)
    {
        if (string.IsNullOrWhiteSpace(text)) return null;
        Report r; try { r = json.Deserialize<Report>(text); } catch { return null; }
        if (r == null || r.Start <= 0) return null;
        Fill(r); if (r.Last <= 0) r.Last = r.Start + r.Secs;
        return r;
    }
    // a session file games.log already has to its last second (a file whose delete failed after its line went in): none
    Report Fresh(Report r) { return r == null || Forgotten(r) || LoggedThrough(r.Game, r.Start) >= r.Last ? null : r; }
    // sessions deleted or cleared in this run: a file read later (held, or not deletable) doesn't bring them back
    readonly HashSet<string> forgotten = new HashSet<string>(); long clearedAt;
    bool Forgotten(Report r) { return forgotten.Contains(r.Game + "|" + r.Start) || (clearedAt > 0 && r.Last <= clearedAt); }
    // two sessions left open (in two of the files): the later goes on, the other is logged at its last second (the same
    // session saved in both: its latest save)
    Report Later(Report a, Report b)
    {
        if (a == null) return b; if (b == null) return a;
        if (a.Game == b.Game && a.Start == b.Start) return a.Last >= b.Last ? a : b;
        Report later = a.Last >= b.Last ? a : b, other = later == a ? b : a;
        LogLeft(other);
        return later;
    }
    void LogLeft(Report o) { if (o.Last - o.Start - o.Gaps.Sum(g => Math.Max(0, g[1] - g[0])) >= 60) Write(o, o.Last); }
    // games.log's lines (and those waiting to go in) for one session: its game and start, with their ends
    List<KeyValuePair<string, long>> SameStart(string game, long start)
    {
        var found = new List<KeyValuePair<string, long>>();
        string key = "\"start\":" + start.ToString(System.Globalization.CultureInfo.InvariantCulture) + ",";
        IEnumerable<string> lines = pending.ToList();
        var have = LogLines(); if (have != null) lines = have.Concat(lines);
        foreach (var l in lines)
        {
            if (l.IndexOf(key, StringComparison.Ordinal) < 0) continue;
            try
            {
                var d = json.DeserializeObject(l) as Dictionary<string, object>;
                if (d != null && d.ContainsKey("game") && d.ContainsKey("end") && (d["game"] as string) == game && Convert.ToInt64(d["start"]) == start)
                    found.Add(new KeyValuePair<string, long>(l, Convert.ToInt64(d["end"])));
            }
            catch { }
        }
        return found;
    }
    // games.log's lines, read with the sharing its append uses; none for no file; null: it can't be read now
    List<string> LogLines()
    {
        try
        {
            if (!File.Exists(logPath)) return new List<string>();
            var l = new List<string>();
            using (var fs = new FileStream(logPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            using (var sr = new StreamReader(fs, new UTF8Encoding(false))) { string x; while ((x = sr.ReadLine()) != null) l.Add(x); }
            return l;
        }
        catch { return null; }
    }
    // a line's game, start and end (null: not a session line)
    Tuple<string, long, long> Key(string line)
    {
        try
        {
            var d = json.DeserializeObject(line) as Dictionary<string, object>;
            if (d == null || !d.ContainsKey("game") || !d.ContainsKey("start") || !d.ContainsKey("end")) return null;
            return Tuple.Create(d["game"] as string, Convert.ToInt64(d["start"]), Convert.ToInt64(d["end"]));
        }
        catch { return null; }
    }
    long LoggedThrough(string game, long start) { var f = SameStart(game, start); return f.Count > 0 ? f.Max(x => x.Value) : -1; }
    // a file whose session is logged or taken: deleted, or (held) emptied, or tried again later
    void Gone(string f)
    {
        try { if (File.Exists(f) && (File.GetAttributes(f) & FileAttributes.ReadOnly) != 0) File.SetAttributes(f, FileAttributes.Normal); } catch { }   // (a restored copy can come back read-only)
        try { File.Delete(f); stale.Remove(f); return; } catch { }
        try { Disk.Swap(f, ""); } catch { }   // (an empty file is no session)
        if (File.Exists(f) && !stale.Contains(f)) stale.Add(f);
    }
    // every 30 s: a file held at the start is read once free (a session the last run left open is logged at its last
    // second: its game, if still running, has a session of its own by now; your own go on, or are logged), this run
    // goes back to the main file, and the files left over go
    void RetryHeld()
    {
        foreach (var f in curUnread.ToList())
        {
            string t = ReadHeld(f, 1);
            if (t == null && File.Exists(f)) continue;
            curUnread.Remove(f);
            var old = ParseCur(t);
            if (old != null && !(rep != null && rep.Game == old.Game && rep.Start == old.Start)) { old = Fresh(old); if (old != null) LogLeft(old); }
            if (f != curPath && f != curMain) Gone(f);   // (the main file is written next, or goes then)
            log(Path.GetFileName(f) + " is free again" + (old != null ? ": the session it held is logged" : ""));
        }
        if (curPath != curMain && !curUnread.Contains(curMain))
        {
            string was = curPath; curPath = curMain;
            if (rep == null) { Gone(curMain); Gone(was); } else if (SaveCur()) Gone(was); else curPath = was;
        }
        foreach (var f in custUnread.ToList())
        {
            string t = ReadHeld(f, 1);
            if (t == null && File.Exists(f)) continue;
            custUnread.Remove(f);
            if (t != null) TakeCustom(t, f);
            if (f != custPath && f != custMain) Gone(f);
            log(Path.GetFileName(f) + " is free again");
        }
        if (custPath != custMain && !custUnread.Contains(custMain))
        {
            string was = custPath; custPath = custMain;
            if (SaveCustom()) Gone(was); else custPath = was;
        }
        else if (custom.Count > 0) SaveCustom();
        foreach (var f in stale.ToList()) Gone(f);
        if (pendHeld.Count > 0) TakePending();
    }
    bool SaveCur() { var r = rep; if (r == null) return false; try { Disk.Swap(curPath, json.Serialize(r)); stale.Remove(curPath); return true; } catch { return false; } }
    public string LogPath { get { return logPath; } }
    public long LastFed { get { var r = rep; return r != null ? r.Last : 0; } }   // the game session's last counted second (0: none)

    // tests (--fake only): a made-up game, in front or not, instead of the processes for the rest of the run; null
    // ends it at once (no 30 s grace)
    bool pretend; string pGame; bool pFront;
    public void Pretend(string game, bool front)
    {
        lock (lk) { pretend = true; pGame = string.IsNullOrEmpty(game) ? null : game; pFront = front; if (pGame == null) Close(); }
        timer.Change(0, 3000);
    }

    void Poll()
    {
        var names = new Dictionary<string, string>();   // game -> one of its exes
        var pids = new Dictionary<string, int>();        // and that exe's process
        string fgName = null, fgExe = null; int fgPid = 0;
        bool pr;
        lock (lk) { pr = pretend; }
        if (!pr)
        {
            // (the game folders: again hourly, and when a program outside all of them comes to the front for the first
            // time, a game installed since, at most once a minute; before 2.1 every Steam manifest, Epic item and uninstall
            // key was read again every 10 minutes)
            if (roots == null || (DateTime.Now - rootsAt).TotalMinutes > 60 || rescan)
            {
                bool first = roots == null;
                roots = GameRoots.Build(); rootsAt = DateTime.Now; rescan = false;
                if (first) log("game folders: " + roots.Count);
            }
            if (++pollNo % 20 == 0) paths.Clear();   // pids get reused: re-resolve every minute
            if (devices == null || pollNo % 200 == 0) devices = Procs.Devices();   // (the drives' names: every 10 minutes)
            int fg = Procs.Foreground();
            var alive = new HashSet<int>(); var inRoot = new HashSet<int>();
            foreach (var pid in Procs.Pids())
            {
                alive.Add(pid);
                string path;
                // (a pid freed and given to a new process between two looks stays alive in the cache: the window in
                // front and anything in a game folder are looked up again every time)
                if (!paths.TryGetValue(pid, out path) || pid == fg || hotPids.Contains(pid)) { path = Procs.ImagePath(pid, devices); paths[pid] = path; }
                if (path == null) continue;
                string lp = path.ToLowerInvariant(), name = null;
                foreach (var r in roots) if (lp.StartsWith(r.Key, StringComparison.Ordinal)) { name = r.Value; break; }   // (both lower case: ordinal, 2.1)
                if (name == null)
                {
                    if (pid == fg && !fgSeen.Contains(lp) && (DateTime.Now - rootsAt).TotalSeconds > 60) { fgSeen.Add(lp); rescan = true; }   // (new in front: maybe a game installed since; within a minute of a rebuild it asks again later, 11-06)
                    continue;
                }
                inRoot.Add(pid);
                if (NotGameExe.IsMatch(Path.GetFileNameWithoutExtension(path))) continue;
                if (pid == fg) { fgName = name; fgExe = Path.GetFileName(path); fgPid = pid; }
                if (!names.ContainsKey(name)) { names[name] = Path.GetFileName(path); pids[name] = pid; }
            }
            foreach (var pid in paths.Keys.Where(k => !alive.Contains(k)).ToList()) paths.Remove(pid);
            hotPids = inRoot;
        }
        long now = Source.Unix();
        lock (lk)
        {
            if (lastNow - now > 5) return;   // (the clock set back and Sample hasn't moved the times back yet: the next look)
            // (tests: the made-up game as it is now, read under the lock a test's change takes too)
            if (pretend) { names.Clear(); pids.Clear(); fgName = fgExe = null; fgPid = 0; if (pGame != null) { names[pGame] = "game.exe"; if (pFront) { fgName = pGame; fgExe = "game.exe"; } } }
            // the session's game stays the game while it runs (a tool beside it doesn't split the session on every
            // alt-tab) unless another game is the one in front for 30 s
            string found;
            if (Game != null && names.ContainsKey(Game))
            {
                found = Game;
                if (fgName != null && fgName != Game) { if (otherSince == 0) otherSince = now; if (now - otherSince >= 30) { found = fgName; otherSince = 0; } }
                else otherSince = 0;
            }
            // a session starts with the game in front (an app that only sits in the background, an overlay or a tool from
            // Steam, never does), or goes on: the one the last run left open, its game still running
            else { found = fgName ?? (resumeGame != null && names.ContainsKey(resumeGame) && now - resumeLast <= 600 ? resumeGame : null); otherSince = 0; }
            InFront = found != null && found == fgName;
            GameExe = found == null ? null : found == fgName ? fgExe : names[found];
            int gp; GamePid = found == null ? 0 : found == fgName ? fgPid : pids.TryGetValue(found, out gp) ? gp : 0;
            if (found != null)
            {
                if (Game != null && (found != Game || now - Seen > 3600)) Close();
                if (Game == null) { Game = found; Since = found == resumeGame && now - resumeLast <= 600 ? resumeStart : found == doneGame && MergeWithin > 0 && now >= doneEnd && now - doneEnd <= MergeWithin ? doneStart : now; }
                Seen = now;
            }
            else if (Game != null && now - Seen > EndAfter) Close();   // gone 5 s: it ends (back within MergeWithin, it goes on: Reopen)
            if (Game != null || now - resumeLast > 600) resumeGame = null;
        }
        polled = true;
    }
    void Close() { Game = null; }   // under lk; the report closes on the next Sample

    static readonly Regex TjRe = new Regex(@"distance to tj ?max", RegexOptions.IgnoreCase);
    // the readings a report follows besides the gated cells: picked by their HWiNFO names
    static readonly string[][] Heads = {
        new[] { "CPU temp", "temp", @"^(CPU \(Tctl/Tdie\)|CPU Package|Core Max|CPU \(Tctl\)|CPU Die \(average\))$", "" },
        new[] { "GPU temp", "temp", @"^GPU Temperature$", "^(?!iGPU)" },
        new[] { "GPU hotspot", "temp", @"^GPU Hot ?Spot Temperature$", "^(?!iGPU)" },
        new[] { "GPU memory", "temp", @"^GPU Memory Junction Temperature$", "^(?!iGPU)" },
        new[] { "CPU power", "power", @"^CPU Package Power$", "" },
        new[] { "GPU power", "power", @"^(GPU Power|Total Board Power( \(TBP\))?|GPU ASIC Power)$", "^(?!iGPU)" },
        new[] { "GPU usage", "usage", @"^(GPU Core Load|GPU Utilization|GPU D3D Usage)$", "^(?!iGPU)" },
        new[] { "CPU usage", "usage", @"^Total CPU Usage$", "" },
        new[] { "VRAM", "mem", @"^(GPU Memory Allocated|GPU D3D Memory Dedicated|GPU Memory Used|GPU Memory Usage)$", "^(?!iGPU)" },
        new[] { "RAM", "mem", @"^Physical Memory Used$", "" } };
    static readonly string[] TypeNames = { "none", "temp", "volt", "fan", "current", "power", "clock", "usage", "other" };
    static readonly Regex FpsRe = new Regex(@"^Framerate( Presented)?( \(avg\))?$"), LowRe = new Regex(@"^Framerate( Presented)? \(1% low\)$");
    static readonly Regex AvailRe = new Regex(@"^(Physical|GPU) Memory Available$");
    int fpsI = -1, lowI = -1, ownFpsI = -1, ownLowI = -1;   // HWiNFO's PresentMon, and HW Deck's own count (Frames) when on
    // a build's own readings for main ones this PC's HWiNFO doesn't share ("GPU usage" -> its key), and the scale of
    // one of them (RAM: what there is), see Extra
    public Dictionary<string, string> OwnHeads = new Dictionary<string, string>();
    public Dictionary<string, Func<double>> OwnTotal = new Dictionary<string, Func<double>>();
    Dictionary<string, string> headName = new Dictionary<string, string>();   // a main reading's key -> its name in the report
    Dictionary<string, int> availOf = new Dictionary<string, int>();   // VRAM / RAM: what is still free beside it, used + free is its scale

    void Pick(Source src)
    {
        if (headVersion == src.Version) return;
        headVersion = src.Version; head = new List<string>(); headName = new Dictionary<string, string>(); fpsI = lowI = -1; availOf = new Dictionary<string, int>();
        foreach (var h in Heads)
        {
            int i = Find(src, h);
            string own;
            if (i < 0 && OwnHeads.TryGetValue(h[0], out own)) i = src.Readings.FindIndex(x => x.Key == own);
            if (i < 0 || head.Contains(src.Readings[i].Key)) continue;
            head.Add(src.Readings[i].Key); headName[src.Readings[i].Key] = h[0];
            if (h[1] != "mem") continue;
            var r = src.Readings[i];
            for (int k = 0; k < src.Readings.Count; k++)
                if (src.Readings[k].Sensor == r.Sensor && src.Readings[k].Unit == r.Unit && Bottleneck.Named(AvailRe, src.Readings[k])) { availOf[r.Key] = k; break; }
        }
        for (int i = 0; i < src.Readings.Count; i++)
        {
            if (!SensorName(src, src.Readings[i]).StartsWith("PresentMon")) continue;
            if (fpsI < 0 && FpsRe.IsMatch(src.Readings[i].Label)) fpsI = i;
            if (lowI < 0 && LowRe.IsMatch(src.Readings[i].Label)) lowI = i;
        }
        ownFpsI = src.Readings.FindIndex(x => x.Key == Frames.FpsKey); ownLowI = src.Readings.FindIndex(x => x.Key == Frames.LowKey);
    }

    // the minute in progress goes into the timeline (minutes the app missed are '-'); next -1: the session ended
    static void Minute(Report r, int next)
    {
        if (r.MinAt >= 0 && r.MinAt < 1440)
        {
            if (r.Tb.Length < r.MinAt) r.Tb += new string('-', r.MinAt - r.Tb.Length);
            while (r.Tf.Count < r.MinAt) { r.Tf.Add(null); r.Tl.Add(null); }
            if (r.Tb.Length == r.MinAt) r.Tb += r.MG + r.MC + r.MF == 0 ? "-" : r.MC >= r.MG && r.MC >= r.MF ? "c" : r.MG >= r.MF ? "g" : "f";
            while (r.Tc.Count < r.MinAt) r.Tc.Add(null);
            if (r.Tc.Count == r.MinAt) r.Tc.Add(r.MG + r.MC + r.MF == 0 ? null : new[] { r.MG, r.MC, r.MF });
            if (r.Tf.Count == r.MinAt) { r.Tf.Add(r.MFn > 0 ? (double?)Math.Round(r.MFs / r.MFn) : null); r.Tl.Add(r.MLn > 0 ? (double?)Math.Round(r.MLs / r.MLn) : null); }
        }
        r.MinAt = next; r.MG = r.MC = r.MF = r.MFn = r.MLn = 0; r.MFs = r.MLs = 0;
    }
    // a games.current.json from an older version lacks the newer fields
    static void Fill(Report r)
    {
        if (r.Tb == null) r.Tb = "";
        if (r.Tc == null) r.Tc = new List<int[]>();   // (an older one's minutes so far stay without it: the page goes by Tb there)
        if (r.Tf == null || r.Tl == null || r.Tf.Count != r.Tl.Count) { r.Tf = new List<double?>(); r.Tl = new List<double?>(); }
        if (r.WarnNames == null || r.WarnUnits == null || r.WarnPeaks == null || r.WarnBelow == null || r.WarnNames.Count != r.WarnPeaks.Count || r.WarnNames.Count != r.WarnUnits.Count || r.WarnNames.Count != r.WarnBelow.Count)
        { r.WarnNames = new List<string>(); r.WarnUnits = new List<string>(); r.WarnPeaks = new List<double>(); r.WarnBelow = new List<bool>(); }
        if (r.Items == null) r.Items = new Dictionary<string, double[]>();
        if (r.Names == null) r.Names = new Dictionary<string, string[]>();
        if (r.Ln == null) r.Ln = new Dictionary<string, Lines>();
        if (r.Gaps == null) r.Gaps = new List<long[]>();
    }
    // a warning during the session: a new one joins the list, one already on it keeps its worst value
    static void Warn(Report r, Alerts.Warm w)
    {
        int i = r.WarnNames.IndexOf(w.Name);
        if (i < 0)
        {
            if (!w.New || r.WarnNames.Count >= 5) return;
            r.WarnNames.Add(w.Name); r.WarnUnits.Add(w.Unit ?? ""); r.WarnPeaks.Add(w.Peak); r.WarnBelow.Add(w.Below);
        }
        else if (w.Below ? w.Peak < r.WarnPeaks[i] : w.Peak > r.WarnPeaks[i]) r.WarnPeaks[i] = w.Peak;
    }

    // once a second from the form's timer: follow the open session; write its line once it ended. call: this second's
    // bottleneck call ('g', 'c', 'f', '-')
    // this session's average fps and 1% low so far, in front (the session report's), for the page's FPS cells (null: no
    // session; 2.1, his m1 pick 11-04)
    public object[] SessionFps()
    {
        var r = rep; if (!polled || r == null) return null;
        return new object[] { r.FpsN > 0 ? Fin(r.FpsSum / r.FpsN, 1) : null, r.LowN > 0 ? Fin(r.LowSum / r.LowN, 1) : null };
    }
    // this session's min, average and max of each of the game's own readings, for the page (null: no session)
    public Dictionary<string, object> SessionPm()
    {
        if (!polled || rep == null || rep.Pm == null) return null;   // (before the first look: still the last run's)
        return rep.Pm.Where(kv => kv.Value != null && kv.Value.Length == 4 && kv.Value[2] > 0)
                     .ToDictionary(kv => kv.Key, kv => (object)new object[] { Fin(kv.Value[0], 2), Fin(kv.Value[1] / kv.Value[2], 2), Fin(kv.Value[3], 2) });
    }
    // the last game session in games.log (the latest end; your own sessions aren't play) and the sessions of the last 24 h
    // as [start, end, secs], for the page's Game cells while no game runs (2.1): null when there is none. Each line's
    // start and end are read by pattern (they come first), only the last one is read whole
    static readonly Regex LgStart = new Regex("\"start\":(-?\\d+)"), LgEnd = new Regex("\"end\":(-?\\d+)"), LgSecs = new Regex("\"secs\":(\\d+)"), LgFront = new Regex("\"front\":(\\d+)");
    public static Dictionary<string, object> LastOf(string text, long now)
    {
        var cand = new List<KeyValuePair<long, string>>(); var day = new List<object>();
        foreach (var raw in (text ?? "").Split('\n'))
        {
            string l = raw.TrimEnd('\r');
            if (!l.StartsWith("{") || l.Contains("\"custom\":")) continue;
            Match a = LgStart.Match(l), b = LgEnd.Match(l), c = LgSecs.Match(l), fm = LgFront.Match(l); long st, en; int secs, fr;
            if (!a.Success || !b.Success || !long.TryParse(a.Groups[1].Value, out st) || !long.TryParse(b.Groups[1].Value, out en) || en <= st) continue;
            cand.Add(new KeyValuePair<long, string>(en, l));
            // (its play: the seconds in front, 11-07; a line from before they were kept: its seconds)
            int all = c.Success && int.TryParse(c.Groups[1].Value, out secs) ? secs : (int)Math.Min(en - st, int.MaxValue);
            if (en > now - 86400) day.Add(new object[] { st, en, fm.Success && int.TryParse(fm.Groups[1].Value, out fr) ? Math.Min(fr, all) : all });
        }
        // (the latest end that reads whole: a line cut by a crash halfway gives way to the one before it)
        Dictionary<string, object> d = null; var js = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
        foreach (var kv in cand.Select((c, i) => new { c, i }).OrderByDescending(x => x.c.Key).ThenByDescending(x => x.i).Select(x => x.c))
        {
            try { d = js.Deserialize<Dictionary<string, object>>(kv.Value); } catch { d = null; }
            if (d != null && d.ContainsKey("game") && d["game"] is string) break;
            d = null;
        }
        if (d == null) return null;
        var o = new Dictionary<string, object>();
        foreach (var k in new[] { "game", "start", "end", "secs", "front", "fps", "low", "g", "c", "f", "tf", "tl", "tb" }) if (d.ContainsKey(k)) o[k] = d[k];
        o["day"] = day;
        return o;
    }
    // a number for the page or games.log: rounded, never NaN or infinite (a file from an older version can hold one)
    static object Fin(double v, int dec) { return double.IsNaN(v) || double.IsInfinity(v) ? null : (object)Math.Round(v, dec); }
    static List<double?> Fin(List<double?> l) { return l == null ? null : l.Select(v => v.HasValue && (double.IsNaN(v.Value) || double.IsInfinity(v.Value)) ? null : v).ToList(); }
    public void Sample(Source src, Dictionary<string, int> index, Dictionary<string, Lines> gated, Alerts alerts, bool frontNow, bool pmOk, HashSet<string> pmKeys, char call, char live)
    {
        var hot = alerts.Hot.ToArray(); alerts.Hot.Clear();
        int fresh = alerts.NewAlerts; alerts.NewAlerts = 0;
        // the clock set back (a time sync): every time kept moves back with it, so the sessions go on with the time they
        // ran (Poll stands aside until this is done: lastNow under the lock)
        long now0 = Source.Unix();
        if (lastNow - now0 > 5) Shift(now0 - lastNow);
        lock (lk) lastNow = now0;
        if (!polled) return;
        string game; bool front; long since, seen;
        lock (lk) { game = Game; front = InFront && frontNow; since = Since; seen = Seen; }
        // the PC slept (or the app stalled) for over 10 minutes: a session ends at its last second, not after the night;
        // a game still running starts a new one now
        for (int i = custom.Count - 1; i >= 0; i--)
        {
            var b = custom[i];   // (the clock set back past its last second: a session you started goes on, moved back with it)
            if (b.Last > 0 && b.Last - now0 > 5) { long d = now0 - b.Last; b.Start += d; b.From += d; b.Last = now0; foreach (var g in b.Gaps) { g[0] += d; g[1] += d; } }
        }
        for (int i = custom.Count - 1; i >= 0; i--)
            if (custom[i].Last > 0 && now0 - custom[i].Last > 600) { var c = custom[i]; custom.RemoveAt(i); if (c.Secs >= 10) Write(c, c.Last); SaveCustom(); }
        if (rep != null && rep.Last > 0 && now0 - rep.Last > 600) { Finish(); lock (lk) { if (Game != null) { Since = now0; since = now0; } } }
        if (pending.Count > 0 && (now0 >= pendNext || pendNext - now0 > 30)) WritePending();   // (refused: again after 5 s, doubling to 30 s, 11-06; or the clock set back)
        if (dropLater.Count > 0 && now0 % 5 == 0) DropLater();
        if ((curUnread.Count > 0 || custUnread.Count > 0 || stale.Count > 0 || pendHeld.Count > 0 || curPath != curMain || custPath != custMain) && now0 % 30 == 0) RetryHeld();
        if (rep != null && (game == null || rep.Start != since)) Finish();
        if (game != null)
        {
            bool started = rep == null;   // (what warned before the session started isn't its warning)
            if (started) rep = Reopen(game, since) ?? new Report { Start = since, From = Source.Unix(), Game = game };
            int secs = rep.Secs;
            // (the game gone a few seconds, before its session ends: no play time and no readings, unless it comes back)
            Feed(rep, src, index, gated, started ? 0 : fresh, started ? new Alerts.Warm[0] : hot, front, front, front && pmOk, pmKeys, call, now0 - seen > 6);
            // (a session taken back: on disk with its first second, then its old line out of the log; a crash in between
            // counts the earlier part twice at worst, never loses it)
            if (reopened)
            {
                reopened = false;
                SaveCur();
                if (reopenLine != null && !pending.Remove(reopenLine)) { try { DropLine(reopenLine); } catch (Exception ex) { log("games: the merged session's line stayed (tried again): " + ex.Message); dropLater.Add(reopenLine); } }
                reopenLine = null; LogChanged = true;
            }
            if (rep.Secs != secs && rep.Secs % 60 == 0) SaveCur();
        }
        // your own sessions, beside the game's, count every second like a game in front: the fps of whatever is in front
        // (PresentMon follows it) and the bottleneck's call of the moment; Front is the time a game was in front
        foreach (var c in custom) Feed(c, src, index, gated, fresh, hot, game != null && front, true, pmKeys.Count > 0, pmKeys, live);
        if (custom.Count > 0 && custom[0].Secs % 60 == 0) SaveCustom();
    }
    // a second of a session: its clock, warnings, what limited the fps (calls), the fps (pm), the readings it follows;
    // front: a game in front
    void Feed(Report rep, Source src, Dictionary<string, int> index, Dictionary<string, Lines> gated, int fresh, Alerts.Warm[] hot, bool front, bool calls, bool pmOk, HashSet<string> pmKeys, char call, bool grace = false)
    {
        Fill(rep);
        rep.Warns += fresh;
        foreach (var w in hot) Warn(rep, w);
        if (grace) return;   // (its warnings count; the PC idling after the game doesn't)
        rep.Last = Source.Unix();
        int minute = (int)Math.Max(0, (rep.Last - rep.Start) / 60);
        if (minute != rep.MinAt) Minute(rep, minute);
        rep.Secs++;   // the session counts with or without HWiNFO; only its readings need it
        if (front) rep.Front++;
        // what limited the fps (a game's: only while it is in front, tabbed out it idles at its background cap)
        if (calls) { if (call == 'g') { rep.G++; rep.MG++; } else if (call == 'c') { rep.C++; rep.MC++; } else if (call == 'f') { rep.F++; rep.MF++; } }
        // (HW Deck's own frame count needs no HWiNFO: with HWiNFO away, its 12 h free-version stop mid-game, it still feeds
        // the session's fps, 11-07 audit)
        Func<int, double> at = i => i >= 0 && i < src.Values.Length && src.Values[i] > 0 ? src.Values[i] : double.NaN;
        Pick(src);   // (first: the readings can change while HWiNFO is away, Accurate game fps turned off, and the indices with them)
        if (src.Status != "ok")
        {
            if (front && !double.IsNaN(at(ownFpsI))) { double f0 = at(ownFpsI), l0 = at(ownLowI); rep.FpsSum += f0; rep.FpsN++; rep.MFs += f0; rep.MFn++; if (!double.IsNaN(l0)) { rep.LowSum += l0; rep.LowN++; rep.MLs += l0; rep.MLn++; } }
            return;
        }
        foreach (var kv in gated) rep.Ln[kv.Key] = kv.Value;
        // fps only while the game is in front and PresentMon follows it: tabbed out, it drops to its background cap
        // and PresentMon follows whatever window is in front instead
        if (pmOk)
        {
            foreach (var key in pmKeys)
            {
                int pi; double[] a;
                if (!index.TryGetValue(key, out pi) || pi >= src.Values.Length || double.IsNaN(src.Values[pi]) || src.Values[pi] <= 0) continue;   // 0: no frames
                double pv = src.Values[pi];
                if (rep.Pm == null) rep.Pm = new Dictionary<string, double[]>();
                if (!rep.Pm.TryGetValue(key, out a)) rep.Pm[key] = a = new[] { pv, 0, 0, pv };
                a[0] = Math.Min(a[0], pv); a[1] += pv; a[2]++; a[3] = Math.Max(a[3], pv);
            }
        }
        // the game's fps while it is in front: HW Deck's own count of its frames when it has some (DirectX games), else
        // HWiNFO's while PresentMon follows it (Vulkan, OpenGL, or the count off)
        double fps = double.NaN, low = double.NaN;
        if (front && !double.IsNaN(at(ownFpsI))) { fps = at(ownFpsI); low = at(ownLowI); }
        else if (pmOk) { fps = at(fpsI); low = at(lowI); }
        if (!double.IsNaN(fps)) { rep.FpsSum += fps; rep.FpsN++; rep.MFs += fps; rep.MFn++; }
        if (!double.IsNaN(low)) { rep.LowSum += low; rep.LowN++; rep.MLs += low; rep.MLn++; }
        foreach (var key in head.Concat(gated.Keys).Concat(Tracked).Distinct())
        {
            if (!pmOk && pmKeys.Contains(key)) continue;
            int i;
            if (!index.TryGetValue(key, out i) || i >= src.Values.Length || double.IsNaN(src.Values[i])) continue;
            double v = src.Values[i];
            double[] it;
            if (!rep.Items.TryGetValue(key, out it))
            {
                it = new[] { 0.0, 0.0, double.MinValue, 0.0 }; rep.Items[key] = it;
                var r = src.Readings[i];
                string hn; bool main = headName.TryGetValue(key, out hn);
                Lines ln;
                string name = main ? hn : gated.TryGetValue(key, out ln) && !string.IsNullOrWhiteSpace(ln.Name) ? ln.Name.Trim() : r.Label;
                bool tj = TjRe.IsMatch(r.Label ?? "") || TjRe.IsMatch(r.Orig ?? "");   // (how far under the throttle point: not a temperature that got hot)
                rep.Names[key] = tj ? new[] { name, r.Unit, main ? "m" : "", "tj" } : new[] { name, r.Unit, main ? "m" : "" };
            }
            else if (it.Length < 4) { var x = new double[4]; Array.Copy(it, x, it.Length); rep.Items[key] = it = x; }
            it[0] += v; it[1]++; if (v > it[2]) it[2] = v;
            int ai; Func<double> tot;
            if (availOf.TryGetValue(key, out ai) && ai < src.Values.Length && src.Values[ai] >= 0) it[3] = Math.Max(it[3], v + src.Values[ai]);
            else if (OwnTotal.TryGetValue(key, out tot)) { double t = tot(); if (t > 0) it[3] = Math.Max(it[3], t); }
        }
    }
    static bool ReadingMatches(Source src, Reading r, string[] h)
    {
        bool kind = h[1] == "mem" ? r.Unit == "MB" || r.Unit == "GB" : TypeNames[Math.Min(8, Math.Max(0, r.Type))] == h[1];
        return kind && (Regex.IsMatch(r.Label, h[2]) || (!string.IsNullOrEmpty(r.Orig) && Regex.IsMatch(r.Orig, h[2]))) && Regex.IsMatch(SensorName(src, r), h[3]);
    }
    static readonly Regex Igpu = new Regex(@"Intel\(R\) (UHD|Iris|HD) Graphics|Intel\(R\) Arc\(TM\) Graphics|Radeon\(TM\) Graphics|Radeon \d{3}M\b|Vega \d+ Graphics", RegexOptions.IgnoreCase);
    static int Find(Source src, string[] h)
    {
        int ig = -1;
        for (int i = 0; i < src.Readings.Count; i++)
            if (ReadingMatches(src, src.Readings[i], h)) { if (!Igpu.IsMatch(SensorName(src, src.Readings[i]))) return i; if (ig < 0) ig = i; }
        return ig;   // only an integrated GPU: that one, then
    }
    public static int GpuUsage(Source src) { return Find(src, Heads.First(h => h[0] == "GPU usage")); }
    static string SensorName(Source src, Reading r) { return r.Sensor >= 0 && r.Sensor < src.Sensors.Count ? src.Sensors[r.Sensor].Name : ""; }

    void Finish()
    {
        var r = rep; rep = null;
        lock (lk) { if (r != null && r.Game == resumeGame && r.Start == resumeStart) resumeGame = null; }   // (logged: the game starting again later is a new session)
        Gone(curPath);
        if (r == null) return;
        // it ended when the game was last seen, or (a run that quit mid-game, a PC that slept) at its last sample
        long end = r.Last > r.Start ? r.Last : Source.Unix();
        lock (lk) if (Seen > r.Start && Seen < end) end = Seen;
        // kept (and on disk, games.done.json): the same game started again within MergeWithin goes on with it (a minute of
        // play too short for a line as well)
        done = r; doneLine = null; lock (lk) { doneGame = r.Game; doneStart = r.Start; doneEnd = end; }
        LogChanged = true;   // (the page's list: the session in progress ended, written or not)
        Fill(r);
        if (end - r.Start - r.Gaps.Sum(g => Math.Max(0, g[1] - g[0])) >= 60) doneLine = Write(r, end);   // under a minute of play (its breaks aren't) isn't a session worth a line
        SaveDone();
    }
    // the session that just ended, on disk too: a HW Deck restart, an update or a reboot in its break keeps the merge
    // (Same game again goes up to 4 hours); written at its end, gone once it is taken back or deleted
    class DoneFile { public Report R; public string Line; public long End; }
    string donePath;
    void SaveDone()
    {
        var d = done; if (d == null) return; long end; lock (lk) end = doneEnd;
        try { Disk.Swap(donePath, json.Serialize(new DoneFile { R = d, Line = doneLine, End = end })); } catch (Exception ex) { log("games: the session that ended isn't kept on disk: " + ex.Message); }
    }
    void DropDone() { try { if (donePath != null && File.Exists(donePath)) File.Delete(donePath); } catch { } }
    void LoadDone()
    {
        try
        {
            if (!File.Exists(donePath)) return;
            var f = json.Deserialize<DoneFile>(File.ReadAllText(donePath));
            long now = Source.Unix();
            // (too old for any window, ahead of the clock, or not a session: gone)
            if (f == null || f.R == null || string.IsNullOrEmpty(f.R.Game) || f.End < f.R.Start || f.End > now + 5 || now - f.End > 4 * 3600) { DropDone(); return; }
            done = f.R; doneLine = f.Line; lock (lk) { doneGame = f.R.Game; doneStart = f.R.Start; doneEnd = f.End; }
        }
        catch (Exception ex) { log("games: games.done.json not read: " + ex.Message); DropDone(); }
    }
    // the same game started again within MergeWithin of its session's end: that session goes on (its line comes out of
    // the log; the break is kept apart, not play); null: a new one
    Report Reopen(string game, long since)
    {
        var d = done; string line = doneLine; long end;
        done = null; doneLine = null; DropDone();
        lock (lk) { end = doneEnd; doneGame = null; }
        if (d == null || d.Game != game || d.Start != since) return null;
        Fill(d);
        long nowR = Source.Unix(); d.Gaps.Add(new[] { Math.Min(end, nowR), nowR });
        // (its line comes out only once the session is on disk again, after its first second: Sample, reopenLine)
        reopened = true; reopenLine = line;
        return d;
    }
    long lastNow;
    // the clock set back by -st seconds: the sessions (in progress, just ended, your own), the times the poller keeps
    // and the last start move back with it
    void Shift(long st)
    {
        Action<Report> mv = r => { if (r == null) return; r.Start += st; r.From += st; r.Last += st; if (r.Gaps != null) foreach (var g in r.Gaps) { g[0] += st; g[1] += st; } };
        mv(rep); mv(done); foreach (var c in custom) mv(c);
        lock (lk)
        {
            if (Since > 0) Since += st; if (Seen > 0) Seen += st; if (doneStart > 0) doneStart += st; if (doneEnd > 0) doneEnd += st; if (otherSince > 0) otherSince += st;
            if (resumeStart > 0) resumeStart += st; if (resumeLast > 0) resumeLast += st;
        }
        if (lastStart > 0) lastStart += st;
        log("the clock was set back " + (-st) + " s: the game sessions moved back with it");
    }
    bool reopened; string reopenLine;
    // merged sessions' old lines the log held when they were to come out, tried again every 5 s (one still waiting
    // to be written just leaves the queue)
    readonly List<string> dropLater = new List<string>();
    void DropLater()
    {
        for (int i = dropLater.Count - 1; i >= 0; i--)
        {
            if (pending.Remove(dropLater[i])) { dropLater.RemoveAt(i); continue; }
            try { DropLine(dropLater[i]); dropLater.RemoveAt(i); LogChanged = true; } catch { }
        }
    }
    // sessions moved by hand (11-02): into the bin, each forgotten like one deleted; back, a merge may take it again
    public void Moved(IEnumerable<string> lines, bool toLog)
    {
        foreach (var l in lines) { var k = Key(l); if (k == null) continue; if (toLog) forgotten.Remove(k.Item1 + "|" + k.Item2); else Forget(k.Item2, k.Item1); }
    }
    // a session deleted or the log cleared: what just ended is not taken back by a merge
    public void Forget(long start = 0, string game = null)
    {
        // (what waits to go into games.log for those sessions goes too: it would bring them back; so would a file read later)
        if (game == null) clearedAt = Source.Unix(); else forgotten.Add(game + "|" + start);
        foreach (var f in stale.ToList()) Gone(f);
        Func<string, bool> theirs = l => { if (game == null) return true; var k = Key(l); return k != null && k.Item1 == game && k.Item2 == start; };
        pending.RemoveAll(l => theirs(l)); dropLater.RemoveAll(l => theirs(l));
        if (game == null) foreach (var f in pendHeld) if (!pendDrop.Contains(f)) pendDrop.Add(f);   // (a held games.log.pending: dropped once read)
        if (pending.Count == 0) PendDone(); else { try { Disk.SwapLines(PendFile(), pending); } catch { } }
        var d = done;
        // (its line's start too: a clock set back since moved the kept session, not its line)
        var dk = doneLine != null ? Key(doneLine) : null;
        if (d == null || (game != null && (d.Game != game || (d.Start != start && !(dk != null && dk.Item2 == start))))) return;
        done = null; doneLine = null; DropDone();
        lock (lk) { doneGame = null; if (Game != null && rep == null && Since == d.Start) Since = Source.Unix(); }   // (its game back already: a new session, not the deleted one's start)
    }
    void DropLine(string line) { lock (LogLock) DropLine0(line); }
    void DropLine0(string line)
    {
        if (!File.Exists(logPath)) return;
        var lines = File.ReadAllLines(logPath).Where(l => !string.IsNullOrWhiteSpace(l)).ToList();
        int i = lines.LastIndexOf(line); if (i < 0) return;
        lines.RemoveAt(i); Disk.SwapLines(logPath, lines);
    }
    // the breaks of the session in progress (Game time leaves them out)
    public long GapSecs
    {
        get
        {
            var r = rep; if (r != null) return r.Gaps != null ? r.Gaps.Sum(g => Math.Max(0, g[1] - g[0])) : 0;
            // (a merge's first second: the session goes on before its report is taken back, its break already counts out)
            var d = done; long since, end; string g0; lock (lk) { since = Since; end = doneEnd; g0 = Game; }
            return d != null && g0 != null && d.Start == since ? (d.Gaps != null ? d.Gaps.Sum(g => Math.Max(0, g[1] - g[0])) : 0) + Math.Max(0, Source.Unix() - end) : 0;
        }
    }
    public List<long[]> GapsNow { get { var r = rep; return r != null && r.Gaps != null ? r.Gaps.ToList() : new List<long[]>(); } }
    // the session in progress's play: its seconds with the game the window in front (his rule 11-07: alt-tabbed isn't
    // play); a merge's first second, before its report is taken back: the earlier part's
    public long FrontSecs
    {
        get
        {
            var r = rep; if (r != null) return r.Front;
            var d = done; long since; string g0; lock (lk) { since = Since; g0 = Game; }
            return d != null && g0 != null && d.Start == since ? d.Front : 0;
        }
    }
    // the session in progress as its line will be (live: 1), for the page's Now playing; null: none
    public Dictionary<string, object> LiveLine()
    {
        var r = rep; string game; lock (lk) game = Game;
        if (r == null || game == null || r.Secs < 1) return null;
        Report c;
        try { c = json.Deserialize<Report>(json.Serialize(r)); } catch { return null; }   // (a copy: the minute in progress goes into its timeline, not the real one's)
        Fill(c); c.Ln = r.Ln;
        var d = Line(c, Math.Max(c.Last, c.Start)); d["live"] = 1;
        return d;
    }
    // a session's line in games.log (returned)
    string Write(Report r, long end)
    {
        // one line per session (its game and start): an earlier save of it (a crash in a merge, a file whose delete
        // failed) comes out; one that ends as late or later is the newer: nothing to write
        var same = SameStart(r.Game, r.Start);
        foreach (var x in same) if (x.Value >= end) return x.Key;
        foreach (var x in same) if (!pending.Remove(x.Key)) { try { DropLine(x.Key); } catch { if (!dropLater.Contains(x.Key)) dropLater.Add(x.Key); } }
        // (from a copy, as LiveLine: the session kept for a merge keeps its minute in progress, so a game back within
        // the same minute adds to it, 11-06)
        Report c;
        try { c = json.Deserialize<Report>(json.Serialize(r)); c.Ln = r.Ln; } catch { c = r; }
        var line = json.Serialize(Line(c, end));
        pending.Add(line);
        WritePending();
        LogChanged = true;
        return line;
    }
    Dictionary<string, object> Line(Report r, long end)
    {
        Fill(r);
        if (r.MinAt >= 0) Minute(r, -1);   // the last minute into the timeline
        Func<double, int, object> avg = (sum, n) => n > 0 ? Fin(sum / n, 0) : null;
        Func<double, object> num = v => double.IsNaN(v) || double.IsInfinity(v) ? null : (object)v;
        // an item: name, unit, avg, max (all an older line has), its yellow and red lines, 1 for a main reading, the
        // scale of VRAM / RAM (used + free) and 1 for lines that warn below
        var items = r.Items.Where(kv => r.Names.ContainsKey(kv.Key)).Select(kv =>
        {
            var nm = r.Names[kv.Key]; Lines ln; r.Ln.TryGetValue(kv.Key, out ln);
            bool main = nm.Length > 2 ? nm[2] == "m" : Heads.Any(h => h[0] == nm[0]);
            double tot = kv.Value.Length > 3 ? kv.Value[3] : 0;
            return (object)new object[] { nm[0], nm[1], Fin(kv.Value[0] / Math.Max(1, kv.Value[1]), 3), Fin(kv.Value[2], 3),
                                          ln != null ? num(ln.Y) : null, ln != null ? num(ln.R) : null, main ? 1 : 0, tot > 0 ? Fin(tot, 1) : null, ln != null && ln.Below ? 1 : 0, kv.Key, nm.Length > 3 && nm[3] == "tj" ? 1 : 0 };
        }).ToList();
        var wl = new List<object>();
        for (int i = 0; i < r.WarnNames.Count; i++) wl.Add(new object[] { r.WarnNames[i], i < r.WarnPeaks.Count ? Fin(r.WarnPeaks[i], 3) : null, i < r.WarnUnits.Count ? r.WarnUnits[i] : "" });
        var d = new Dictionary<string, object> { { "game", r.Game }, { "start", r.Start }, { "end", end }, { "from", r.From }, { "secs", r.Secs }, { "front", r.Front },
                                                 { "fps", avg(r.FpsSum, r.FpsN) }, { "low", avg(r.LowSum, r.LowN) }, { "items", items }, { "warns", r.Warns },
                                                 { "g", r.G }, { "c", r.C }, { "f", r.F }, { "wl", wl }, { "tf", Fin(r.Tf) }, { "tl", Fin(r.Tl) }, { "tb", r.Tb }, { "tc", r.Tc }, { "p", 3 }, { "bv", 2 } };   // p: the decimals its items keep; bv: the bottleneck's rule (2: the pace of the frames, 2.0.1)
        if (r.Custom == 1) d["custom"] = 1;
        if (r.Gaps.Count > 0) d["gaps"] = r.Gaps;
        return d;
    }

    // ---- sessions from before 2.0.1, re-estimated once (2.1, his ask 11-04 "fix the previous game sessions, and when
    // users update the app, the app should fix those as well"). Their capped seconds were a GPU under 85% with no CPU
    // thread at 80%; since 2.0.1 capped needs the frames at a held pace, and those sessions didn't keep their frames.
    // They kept their minutes: a capped game holds its fps at one value minute after minute, an uncapped one goes up
    // and down. So a capped minute stays capped when its average fps sits on a plateau (within 2% of at least 5 of the
    // session's capped minutes, and of 15% of them) or at a cap the same game showed in another session (a plateau of
    // its own, or a minute 2.0.1 called capped most of the time), for a session too short to tell (under 5 capped
    // minutes with an fps: a short one at the game's usual cap). A longer one goes by its own plateau alone: an uncapped
    // one passes through any fps, the game's caps among them. The rest of its capped seconds is CPU bound, also in a
    // minute without an fps (2.0.1 can't see a cap there either). A session made by 2.0.1 or later is left alone: one
    // that says its rule (bv, 2.1 on), or one that started after this data folder first ran 2.0.1 or 2.0.2
    // (PaceStartIn; never before 2.0.1 came out) ----
    public const long PaceRuleSince = 1793739000;   // 2026-11-03 20:50 UTC, 2.0.1 out
    static readonly JavaScriptSerializer estJson = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
    // when this data folder first ran 2.0.1 or 2.0.2, from its app.log's start lines (not before 2.0.1 came out); else
    // now: whatever it logged so far, an older version made
    public static long PaceStartIn(string appLog)
    {
        try
        {
            if (File.Exists(appLog))
                foreach (var l in File.ReadLines(appLog))
                {
                    int i = l.IndexOf("  start 2.0.", StringComparison.Ordinal);
                    if (i <= 0 || l.Length < i + 14 || (l[i + 12] != '1' && l[i + 12] != '2') || l[i + 13] != ' ') continue;
                    DateTimeOffset t;
                    if (DateTimeOffset.TryParse(l.Substring(0, i), System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.None, out t)) return Math.Max(PaceRuleSince, t.ToUnixTimeSeconds());
                }
        }
        catch { }
        return Math.Max(PaceRuleSince, Source.Unix());
    }
    // a session line with its minutes (null: not one); old: made by the old call (started before `before`, no bv), not
    // re-estimated yet
    static Dictionary<string, object> EstRead(string line, out bool old, long before = PaceRuleSince)
    {
        old = false;
        if (line == null || !line.StartsWith("{") || line.IndexOf("\"tc\":", StringComparison.Ordinal) < 0) return null;
        Dictionary<string, object> d; long st;
        try { d = estJson.DeserializeObject(line) as Dictionary<string, object>; } catch { return null; }
        if (d == null || !d.ContainsKey("start") || !d.ContainsKey("f") || !d.ContainsKey("c") || !(d.ContainsKey("tc") && d["tc"] is object[])) return null;
        try { st = Convert.ToInt64(d["start"]); } catch { return null; }
        old = st < before && !d.ContainsKey("bv") && !d.ContainsKey("est");
        return d;
    }
    // a minute's [gpu, cpu, capped] seconds (null: none) and its average fps (0: none)
    static int[] EstCell(object[] tc, int i) { var a = tc[i] as object[]; if (a == null || a.Length != 3) return null; try { return new[] { Convert.ToInt32(a[0]), Convert.ToInt32(a[1]), Convert.ToInt32(a[2]) }; } catch { return null; } }
    static double EstFps(object[] tf, int i) { if (tf == null || i >= tf.Length || tf[i] == null) return 0; try { return Convert.ToDouble(tf[i], System.Globalization.CultureInfo.InvariantCulture); } catch { return 0; } }
    static bool Near(double a, double v) { return Math.Abs(a - v) <= 0.02 * v; }
    // the capped minutes on a plateau of the session's own
    static HashSet<int> EstPlateau(object[] tc, object[] tf)
    {
        var withFps = Enumerable.Range(0, tc.Length).Where(i => { var c = EstCell(tc, i); return c != null && c[2] > 0 && EstFps(tf, i) > 0; }).ToList();
        double need = Math.Max(5, 0.15 * withFps.Count);
        return new HashSet<int>(withFps.Where(i => withFps.Count(j => Near(EstFps(tf, j), EstFps(tf, i))) >= need));
    }
    // the fps a session shows its game capped at: its plateau before 2.0.1; since, the minutes capped most of the time
    static IEnumerable<double> EstCaps(Dictionary<string, object> d, bool old)
    {
        var tc = (object[])d["tc"]; var tf = d.ContainsKey("tf") ? d["tf"] as object[] : null;
        if (old) return EstPlateau(tc, tf).Select(i => EstFps(tf, i)).ToList();
        return Enumerable.Range(0, tc.Length).Where(i => { var c = EstCell(tc, i); return c != null && c[2] >= 30 && EstFps(tf, i) > 0; }).Select(i => EstFps(tf, i)).ToList();
    }
    // one line, re-estimated (moved: the capped seconds now CPU bound, 0: the line as it was); caps: per game, the fps
    // its sessions show it capped at (EstCaps). The line gets "est", those seconds
    public static string Reestimate(string line, out int moved, IDictionary<string, List<double>> caps = null, long before = PaceRuleSince)
    {
        moved = 0; bool old;
        if (line == null || line.IndexOf("\"est\":", StringComparison.Ordinal) >= 0 || line.IndexOf("\"bv\":", StringComparison.Ordinal) >= 0) return line;
        var d = EstRead(line, out old, before);
        if (d == null || !old) return line;
        var tc = (object[])d["tc"]; var tf = d.ContainsKey("tf") ? d["tf"] as object[] : null;
        List<double> known = null; string game = d.ContainsKey("game") ? d["game"] as string : null;
        int judged = Enumerable.Range(0, tc.Length).Count(i => { var c = EstCell(tc, i); return c != null && c[2] > 0 && EstFps(tf, i) > 0; });
        if (caps != null && game != null && judged < 5) caps.TryGetValue(game, out known);   // (too short to tell on its own)
        var plateau = EstPlateau(tc, tf); var tbc = (d.ContainsKey("tb") ? d["tb"] as string ?? "" : "").ToCharArray();
        int sum = 0;
        for (int i = 0; i < tc.Length; i++)
        {
            var c = EstCell(tc, i); if (c == null || c[2] <= 0) continue;
            double v = EstFps(tf, i);
            if (plateau.Contains(i) || (v > 0 && known != null && known.Any(k => Near(k, v)))) continue;   // (at a cap)
            sum += c[2]; c[1] += c[2]; c[2] = 0;
            tc[i] = new object[] { c[0], c[1], c[2] };
            if (i < tbc.Length && tbc[i] != '-') tbc[i] = c[1] >= c[0] && c[1] >= c[2] ? 'c' : c[0] >= c[2] ? 'g' : 'f';   // (as Minute picks it)
        }
        int f0, c0; try { f0 = Convert.ToInt32(d["f"]); c0 = Convert.ToInt32(d["c"]); } catch { return line; }
        int mv = Math.Min(sum, Math.Max(0, f0));
        if (mv <= 0) return line;
        d["f"] = f0 - mv; d["c"] = c0 + mv; d["tc"] = tc; if (d.ContainsKey("tb")) d["tb"] = new string(tbc); d["est"] = mv;
        moved = mv;
        return estJson.Serialize(d);
    }
    // files of session lines (games.log, its bin), read together for the games' caps: a copy of each as it was kept
    // beside it first (no copy, nothing changed). True: all read, and written where something changed; changed: the
    // sessions it changed
    public static bool ReestimateFiles(string[] paths, object lk, Action<string> log, long before = PaceRuleSince) { int n; return ReestimateFiles(paths, lk, log, before, out n); }
    public static bool ReestimateFiles(string[] paths, object lk, Action<string> log, long before, out int changed)
    {
        changed = 0;
        try
        {
            lock (lk)
            {
                var files = paths.Where(File.Exists).Select(p => new KeyValuePair<string, string[]>(p, File.ReadAllLines(p))).ToList();
                var caps = new Dictionary<string, List<double>>();
                foreach (var l in files.SelectMany(f => f.Value))
                {
                    bool old; var d = EstRead(l, out old, before); string g = d != null && d.ContainsKey("game") ? d["game"] as string : null;
                    if (g == null) continue;
                    List<double> have; if (!caps.TryGetValue(g, out have)) caps[g] = have = new List<double>();
                    have.AddRange(EstCaps(d, old));
                }
                bool all = true;
                foreach (var f in files)
                {
                    int n = 0, secs = 0; var outL = new List<string>(f.Value.Length);
                    foreach (var l in f.Value) { int mv; outL.Add(Reestimate(l, out mv, caps, before)); if (mv > 0) { n++; secs += mv; } }
                    if (n == 0) continue;
                    string keep = f.Key + ".before-2.1";
                    try
                    {
                        if (!File.Exists(keep)) File.Copy(f.Key, keep);
                        Disk.SwapLines(f.Key, outL); changed += n;
                        log(Path.GetFileName(f.Key) + ": " + n + (n == 1 ? " session" : " sessions") + " from before 2.0.1 re-estimated (" + secs + " s that read capped are CPU bound now); as it was: " + Path.GetFileName(keep));
                    }
                    catch (Exception ex) { log(Path.GetFileName(f.Key) + ": sessions not re-estimated (tried again at the next start): " + ex.Message); all = false; }
                }
                return all;
            }
        }
        catch (Exception ex) { log("games: sessions not re-estimated (tried again at the next start): " + ex.Message); return false; }
    }
    // session lines not in games.log yet (a write that failed is tried again every second and at exit, not dropped)
    readonly List<string> pending = new List<string>();
    void WritePending() { lock (LogLock) WritePending0(); }
    void WritePending0()
    {
        // (one line per session, judged by games.log as it is now: a line it already has as long or longer isn't added,
        // an earlier, shorter one of the same session comes out; Write judged it too, maybe while the log couldn't be read)
        var have = LogLines(); var blocked = new List<string>();
        if (have != null)
        {
            // (only the lines with a pending session's start are parsed, as SameStart reads them, 11-07 audit: the whole log at
            // every session's end, on the UI thread, a longer freeze each month)
            var starts = pending.Select(l => Key(l)).Where(k => k != null).Select(k => "\"start\":" + k.Item2.ToString(System.Globalization.CultureInfo.InvariantCulture) + ",").Distinct().ToList();
            var keys = have.Where(l => starts.Any(st => l.IndexOf(st, StringComparison.Ordinal) >= 0)).Select(l => new { l, k = Key(l) }).Where(x => x.k != null).ToList();
            foreach (var line in pending.ToList())
            {
                var k = Key(line); if (k == null) continue;
                var same = keys.Where(x => x.k.Item1 == k.Item1 && x.k.Item2 == k.Item2).ToList();
                if (same.Any(x => x.k.Item3 >= k.Item3)) { pending.Remove(line); continue; }
                // (an earlier line of it the log won't give up yet: not added beside it, it waits, on disk too)
                foreach (var x in same) { try { DropLine(x.l); dropLater.Remove(x.l); LogChanged = true; } catch { blocked.Add(line); break; } }
            }
        }
        var go = pending.Where(l => !blocked.Contains(l)).ToList();
        if (pending.Count == 0) { pendWait = 0; PendDone(); return; }
        if (go.Count == 0) { SavePend(); PendLater(); return; }
        try { Disk.AppendLines(logPath, go); LogChanged = true; foreach (var l in go) pending.Remove(l); if (pending.Count == 0) { pendWait = 0; PendDone(); } else { SavePend(); PendLater(); } }
        catch (Exception ex)
        {
            if (pending.Count == 1) log("game report write failed (tried again): " + ex.Message);
            SavePend(); PendLater();   // (on disk meanwhile: a quit or a crash before it goes in loses nothing)
        }
    }
    // (11-06: a line games.log refused is tried again after 5 s, doubling to 30 s: every second it read and parsed the
    // whole log; games.pending is written only when what it holds changed)
    long pendNext; int pendWait; string pendSaved;
    void PendLater() { pendWait = pendWait == 0 ? 5 : Math.Min(30, pendWait * 2); pendNext = Source.Unix() + pendWait; }
    void SavePend()
    {
        string f = PendFile(), sig = f + "\n" + string.Join("\n", pending);
        if (sig == pendSaved && File.Exists(f)) return;
        try { Disk.SwapLines(f, pending); pendSaved = sig; } catch { }
    }
    // games.log.pending, or .pending.2 while the first is held unread (never written over before it is read)
    readonly List<string> pendHeld = new List<string>(), pendDrop = new List<string>();   // pendDrop: held ones cleared meanwhile
    string PendFile() { return pendHeld.Contains(pendPath) ? pendPath + ".2" : pendPath; }
    void PendDone() { pendSaved = null; foreach (var f in new[] { pendPath, pendPath + ".2" }) if (!pendHeld.Contains(f) && File.Exists(f)) { try { File.Delete(f); } catch { } } }
    // lines games.log refused at the last quit or crash: in now, once (one line per session, as Write)
    void TakePending()
    {
        foreach (var f in new[] { pendPath, pendPath + ".2" })
        {
            if (!File.Exists(f)) { pendHeld.Remove(f); continue; }
            string t = ReadHeld(f, pendHeld.Contains(f) ? 1 : 5);
            if (t == null) { if (File.Exists(f) && !pendHeld.Contains(f)) { pendHeld.Add(f); log(Path.GetFileName(f) + " is held by another program: read once it is free"); } continue; }
            pendHeld.Remove(f);
            if (pendDrop.Remove(f)) { try { File.Delete(f); } catch { } continue; }   // (the sessions were cleared while it was held)
            TakePendingLines(t.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries));
        }
        if (pending.Count > 0) { WritePending(); LogChanged = true; } else PendDone();
    }
    void TakePendingLines(string[] ls)
    {
        foreach (var l in ls.Where(x => !string.IsNullOrWhiteSpace(x)))
        {
            try
            {
                var d = json.DeserializeObject(l) as Dictionary<string, object>;
                if (d == null || !d.ContainsKey("game") || !d.ContainsKey("start") || !d.ContainsKey("end")) continue;
                string g = d["game"] as string; long st = Convert.ToInt64(d["start"]), en = Convert.ToInt64(d["end"]);
                var same = SameStart(g, st);
                if (same.Any(x => x.Value >= en)) continue;
                foreach (var x in same) if (!pending.Remove(x.Key)) { try { DropLine(x.Key); } catch { if (!dropLater.Contains(x.Key)) dropLater.Add(x.Key); } }
                pending.Add(l);
            }
            catch { }
        }
    }
    public void Flush()
    {
        SaveCur(); SaveCustom(); DropLater();
        if (pending.Count > 0) WritePending();
    }

    // ---- sessions of your own: started and stopped by hand, named by you, any number at once beside a game's (all
    // on the form's thread). games.custom.json holds them while they run: a restart within 10 minutes goes on with
    // them, a longer gap ends them at their last second ----
    public const int MaxCustom = 8;
    long lastStart;
    readonly List<Report> custom = new List<Report>();
    void LoadCustom()
    {
        var read = new List<string>();
        foreach (var f in new[] { custMain, Spare(custMain, 2), Spare(custMain, 3) })
        {
            if (!File.Exists(f)) continue;
            string t = ReadHeld(f);
            if (t == null && File.Exists(f)) { custUnread.Add(f); continue; }
            read.Add(f); TakeCustom(t, f);
        }
        custPath = new[] { custMain, Spare(custMain, 2), Spare(custMain, 3) }.First(f => !custUnread.Contains(f) || f.EndsWith(".3.json"));
        if (custUnread.Count > 0) log(Path.GetFileName(custUnread[0]) + " is held by another program: saving to " + Path.GetFileName(custPath) + " until it is free");
        if (read.Count == 0) return;
        if (SaveCustom()) foreach (var f in read) if (f != custPath) Gone(f);
    }
    void TakeCustom(string text, string from)
    {
        List<Report> list;
        if (string.IsNullOrWhiteSpace(text)) return;
        try { list = json.Deserialize<List<Report>>(text) ?? new List<Report>(); }
        catch (Exception ex)   // (put aside, not deleted: its sessions can still be read by hand)
        {
            log(Path.GetFileName(from) + " can't be read: " + ex.Message);
            try { File.Move(from, from + ".bad-" + DateTime.Now.ToString("yyyyMMdd-HHmmss", System.Globalization.CultureInfo.InvariantCulture)); } catch { }
            return;
        }
        long now = Source.Unix();
        foreach (var r in list.Where(x => x != null && x.Start > 0).Take(MaxCustom))
        {
            r.Custom = 1; Fill(r);
            if (r.Last <= 0) r.Last = r.Start + r.Secs;
            if (custom.Any(c => c.Start == r.Start && c.Game == r.Game)) continue;   // (the same session in two files)
            if (r.Last - now > 5) { if (r.Secs >= 10) Write(r, r.Last); continue; }   // (ahead of the clock: logged at its own times)
            if (Forgotten(r) || LoggedThrough(r.Game, r.Start) >= r.Last) continue;   // (stopped and logged already: a file whose delete failed; deleted)
            if (now - r.Last <= 600 && custom.Count < MaxCustom) custom.Add(r); else if (r.Secs >= 10) Write(r, r.Last);
        }
    }
    bool SaveCustom()
    {
        if (custom.Count == 0) { Gone(custPath); return true; }
        try { Disk.Swap(custPath, json.Serialize(custom)); stale.Remove(custPath); return true; } catch { return false; }
    }
    public static string CleanName(object o)
    {
        var s = o as string; if (s == null) return null;
        s = Regex.Replace(s, @"[\x00-\x1f\x7f]+", " ").Trim();
        return s.Length == 0 ? null : s.Length > 60 ? s.Substring(0, 60).Trim() : s;
    }
    // for the page: [start, name] of each one running
    public List<object> Running() { return custom.Select(r => (object)new object[] { r.Start, r.Game }).ToList(); }
    public string StartCustom(object name)   // null, or why it didn't start
    {
        if (custom.Count >= MaxCustom) return MaxCustom + " sessions of your own at once at most: stop one first";
        long now = Source.Unix();
        if (now - lastStart < 2) return null;   // (a double click)
        lastStart = now;
        custom.Add(new Report { Start = now, From = now, Last = now, Game = CleanName(name) ?? "Session", Custom = 1 });
        SaveCustom();
        return null;
    }
    public bool StopCustom(long start)   // false: under 10 seconds, not kept
    {
        int i = custom.FindIndex(x => x.Start == start); if (i < 0) return true;
        var r = custom[i]; custom.RemoveAt(i); SaveCustom();
        if (r.Secs < 10) return false;
        Write(r, Math.Max(r.Start, Source.Unix()));
        return true;
    }
    public void RenameCustom(long start, object name)
    {
        var r = custom.Find(x => x.Start == start); string n = CleanName(name);
        if (r != null && n != null) { r.Game = n; SaveCustom(); }
    }

    // ---- the log edited in place: a session deleted or renamed, the ones older than you keep dropped. Written whole
    // through a temp file; a line that goes is kept in games.log.bak first, like a Clear. f: 0 keeps a line, 1 drops
    // it, 2 writes it again changed ----
    public int EditLog(Func<Dictionary<string, object>, int> f, Func<string, bool> maybe = null, bool once = false) { lock (LogLock) return EditLog0(f, maybe, once); }
    int EditLog0(Func<Dictionary<string, object>, int> f, Func<string, bool> maybe, bool once)
    {
        if (!File.Exists(logPath)) return 0;
        var keep = new List<string>(); var gone = new List<string>(); int n = 0;
        foreach (var line in File.ReadAllLines(logPath))
        {
            if (string.IsNullOrWhiteSpace(line)) continue;
            if ((maybe != null && !maybe(line)) || (once && n > 0)) { keep.Add(line); continue; }   // (not this one: kept as it is)
            Dictionary<string, object> o = null;
            try { o = json.Deserialize<Dictionary<string, object>>(line); } catch { }
            int a = o == null ? 0 : f(o);
            if (a == 1) { gone.Add(line); n++; } else if (a == 2) { keep.Add(json.Serialize(o)); n++; } else keep.Add(line);
        }
        if (n == 0) return 0;
        if (gone.Count > 0) { Disk.AppendLines(logPath + ".bak", gone); DeckForm.ShortenBin(logPath + ".bak", DeckForm.Bytes(gone)); }   // (first: a failed swap leaves a copy twice, never none)
        Disk.SwapLines(logPath, keep);
        return n;
    }
    public static long Long(object o) { try { return Convert.ToInt64(o, System.Globalization.CultureInfo.InvariantCulture); } catch { return long.MinValue; } }
    // the line of one session: its start, end and name
    public static bool Is(Dictionary<string, object> o, long start, long end, string game)
    {
        object s, e, g;
        return o.TryGetValue("start", out s) && Long(s) == start && o.TryGetValue("end", out e) && Long(e) == end && o.TryGetValue("game", out g) && g as string == game;
    }
}

partial class DeckForm : Form
{
    [DllImport("user32.dll")] static extern bool ReleaseCapture();
    [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr hWnd, int msg, int wParam, int lParam);
    [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr hWnd);
    [DllImport("user32.dll")] static extern int GetSystemMetricsForDpi(int nIndex, uint dpi);
    [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] static extern uint GetDpiForSystem();
    const int WM_NCLBUTTONDOWN = 0xA1;
    const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";

    readonly string appDir = AppDomain.CurrentDomain.BaseDirectory, dataDir;
    readonly DeckSource src;
    readonly History hist;
    readonly Alerts alerts = new Alerts();
    readonly Games games;
    readonly NotifyIcon tray;
    readonly WebView2 wv;
    readonly Timer timer;
    readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
    readonly bool fake, customData;
    bool hsFeedSaid;   // (the headset page's readings failed once: said once)
    bool flushAsked, flushDone;   // (a quit waits for the page's waiting saves, 11-17)
    bool exiting, startHidden, pageReady, force, wasShowing, paused, nonClient = true, wvFailed, restoreMax;
    long notOkSince;
    bool restarting;   // a HWiNFO restart under way
    // settings.json was damaged: no trims by days nobody chose, in this run and the next ones, each log until its days
    // are set again
    bool settingsBad { get { return settings.ContainsKey("daysUnknown"); } }
    bool DaysSet(string k) { return !settingsHeld && (!settingsBad || settings.ContainsKey(k)); }   // (held: the real days unknown this run)
    bool settingsHeld;   // settings.json held by another program at start: defaults (never saved over it) until it can be read
    // the run started on an empty set, so every key in it now was set in this run: those stay on top of the file's
    void RetrySettings()
    {
        settingsHeld = false;
        var d = ReadSettings(1);
        if (settingsHeld) return;
        bool changed = settings.Count > 0;
        foreach (var kv in settings) d[kv.Key] = kv.Value;
        settings = d; games.MergeWithin = MergeMins() * 60;
        Log("settings.json read after all" + (changed ? ", with the changes made meanwhile" : ""));
        if (changed) SaveSettings();
        SettingsPasses();   // (the start's passes, held then)
        TrimAlerts(); TrimGames();   // (the start's trims ran on unknown days: nothing cut then)
        if (src.Frames != null && FpsWanted && !Brand.NoActions) Try(() => src.Frames.Start());
        if (pageReady) SendSettings();
    }
    void SettingsPasses()
    {
        // (2.4.2, his asks 11-07: a note for each update, stacked. notesSeen: the version whose notes were seen. The first
        // start with them: the oldest version this install ran (its app.log), so an update to this one still gets the
        // notes of every update it went through before there were notes, and no others; none, a new install: this one,
        // nothing to catch up on. A test copy starts with nothing to show)
        if (!(settings.ContainsKey("notesSeen") && settings["notesSeen"] is string)) { settings["notesSeen"] = (fake && Ver(Environment.GetEnvironmentVariable("HWDECK_RUNVER")) == null ? null : OldestStartIn(P("app.log"))) ?? AppInfo.Run; SaveSettings(); }   // (a test copy told to run as a version, even this one, reads its app.log like an install)
        // (2.1: the sessions from before 2.0.1, once per data folder. estBefore: the first start of 2.0.1 or 2.0.2 in
        // its app.log, else this one, kept from the first try; estDone once a pass read and wrote both files; estNote:
        // how many changed, for the page's note until its X)
        if (!true.Equals(settings.ContainsKey("estDone") ? settings["estDone"] : null))
        {
            long before = 0; try { if (settings.ContainsKey("estBefore")) before = Convert.ToInt64(settings["estBefore"]); } catch { }
            if (before <= 0) before = Games.PaceStartIn(P("app.log"));
            settings["estBefore"] = before;
            int changed;
            if (Games.ReestimateFiles(new[] { P("games.log"), P("games.log.bak") }, games.LogLock, Log, before, out changed)) { settings["estDone"] = true; if (changed > 0) settings["estNote"] = changed; }
            SaveSettings();
        }
    }
    Dictionary<string, object> ReadSettings(int tries = 5)
    {
        string p = P("settings.json"), text = null;
        if (!File.Exists(p)) return new Dictionary<string, object>();
        // (a sync or backup tool can hold it for a moment at logon: that isn't damage)
        for (int i = 0; i < tries && text == null; i++)
            try { text = File.ReadAllText(p); }
            catch (FileNotFoundException) { return new Dictionary<string, object>(); }
            catch (IOException) { if (i + 1 < tries) System.Threading.Thread.Sleep(200); }
            catch (UnauthorizedAccessException) { if (i + 1 < tries) System.Threading.Thread.Sleep(200); }
        if (text == null) { if (tries > 1) Log("settings.json is held by another program: running on defaults, read again every 5 s, not saving over it"); settingsHeld = true; return new Dictionary<string, object>(); }
        try { var d = json.DeserializeObject(text) as Dictionary<string, object>; if (d != null) return d; } catch { }
        // damaged: kept aside (the next save would write over it), and the days count as unknown
        Log("settings.json can't be read: kept aside, nothing trimmed by days until they are set again");
        string bad = P("settings.json.bad-" + DateTime.Now.ToString("yyyyMMdd-HHmmss", System.Globalization.CultureInfo.InvariantCulture));
        var fresh = new Dictionary<string, object> { { "daysUnknown", true } };
        if (Try(() => File.Move(p, bad))) Try(() => SaveFile("settings", fresh));   // (saved at once: a run that ends before any other save still leaves the flag)
        return fresh;
    }
    string stateBad;                        // a state.json that couldn't be read, kept under this name
    HashSet<string> pmKeys = new HashSet<string>(); int pmVersion = -1;
    int sentVersion = -1;
    long lastSecond, lastSave = Source.Unix(), lastFull = Source.Unix(), lastHwPath;
    HashSet<string> subCells = new HashSet<string>(), subRows = new HashSet<string>();
    Dictionary<string, Games.Lines> gated = new Dictionary<string, Games.Lines>();
    Dictionary<string, int> index = new Dictionary<string, int>();
    int indexVersion = -1;
    object layout;                          // the working layout, for the warning log
    Dictionary<string, object> settings;
    MenuItem autoItem;
    readonly string runName;                // the Start with Windows entry: one per data folder

    string P(string name) { return Path.Combine(dataDir, name); }
    void Log(string s)
    {
        try
        {
            string p = P("app.log");
            var fi = new FileInfo(p);
            if (fi.Exists && fi.Length > 1000000) { try { File.Delete(p + ".old"); File.Move(p, p + ".old"); } catch { } }
            File.AppendAllText(p, AppInfo.Stamp() + "  " + s + "\r\n");
        }
        catch { }
    }

    public DeckForm(bool min, string data, bool custom, int fakeN)
    {
        startHidden = min;
        dataDir = data; customData = custom;
        Directory.CreateDirectory(dataDir);
        Directory.CreateDirectory(P("slots"));
        fake = fakeN > 0;
        if (fake && Ver(Environment.GetEnvironmentVariable("HWDECK_RUNVER")) != null) AppInfo.Run = Environment.GetEnvironmentVariable("HWDECK_RUNVER");
        if (NoFocus) focusAtStart = GetForegroundWindow();
        src = new DeckSource(fake ? (Source)new FakeSource(fakeN) : new HwSource());
        src.Inner.Note = s => Log(s);
        Net.Log = s => Log(s); Net.Fake = fake; Net.File_ = P("net.json"); Net.Load();
        // (the headset, 11-13: its screen's switch and pages, the mouse's last reading; read by HW Deck itself)
        Batt.Log = s => Log(s); Batt.ScreenFile = P("hs-screen.txt"); Batt.StateFile = P("batt.txt");
        HsPage.File_ = P("hs-layout.json"); HsPage.Log = s => Log(s);
        HsPage.Gaming = () => games != null && games.Game != null;   // (a headset page's Shows: while gaming or not)

        Net.Toast = why => { try { BeginInvoke((Action)(() => { var r = Msg("toast"); r["text"] = why; Post(r); })); } catch { } };
        alerts.Conn = src.Conn;
        hist = new History(dataDir);
        games = new Games(dataDir, Log);
        // (tests: a copy blind to the games running on this PC, so a run while he plays gets only its made-up ones)
        if (fake && Environment.GetEnvironmentVariable("HWDECK_NOGAMES") == "1") games.Pretend(null, false);
        runName = custom ? Brand.Name + " (" + Path.GetFileName(data) + " " + ((uint)data.ToLowerInvariant().Aggregate(2166136261u, (h, ch) => (h ^ ch) * 16777619u)).ToString("x8") + ")" : Brand.Name;
        settings = ReadSettings();
        Net.On = settings.ContainsKey("netTest") && true.Equals(settings["netTest"]);   // (the speed test's switch, off unless turned on, 2.4.8)
        Net.Gaming = () => games != null && games.Game != null && Source.Unix() - games.Seen <= 6;
        games.MergeWithin = MergeMins() * 60;
        // (the start's passes over settings.json, the update notes seen and the sessions' re-estimate, run on the file as it
        // is: held by another program, they wait for RetrySettings, 11-07 audit; the oldest version's notesSeen went over
        // the file's, and every note put away came back)
        if (!settingsHeld) SettingsPasses();
        // the game's own frames (Settings: Accurate game fps): on when it was turned on and Windows lets this account trace
        // (trace names are for the whole PC: the account's own id in it, so two accounts signed in at once don't stop each other's)
        if (!fake) { src.Frames = new Frames(runName + " frames " + System.Security.Principal.WindowsIdentity.GetCurrent().User.Value); if (FpsWanted && !Brand.NoActions) src.Frames.Start(); }   // (a test copy never takes over the trace)
        // (a session over 10 minutes quiet, the PC asleep, is about to end: not its length with the sleep in it)
        // (the game gone, in its grace: held at its last counted second, as the session is)
        // (11-07, his rule: play is the time the game is the window in front, so alt-tabbed and its breaks don't count)
        src.GameMin = () => { string g = games.Game; long since = games.Since, last = games.LastFed, now = Source.Unix(); return g != null && since > 0 && !(last > 0 && now - last > 600) ? Math.Max(0, games.FrontSecs) / 60.0 : double.NaN; };
        var st = ReadFile("state", true) as Dictionary<string, object>;
        if (st != null && st.ContainsKey("L")) layout = st["L"];
        TrimAlerts(); TrimGames();

        Text = Brand.Name;
        // sizes in logical pixels, scaled to the screen (225% on a 4K screen would otherwise make a postage stamp)
        float k = 1f;
        try { k = GetDpiForSystem() / 96f; } catch { }   // DeviceDpi still says 96 before the window exists
        // it opens on the screen under the mouse; a copy that never takes the focus (a test's) on another screen than the
        // main one when there is one, away from a game or work there
        var wa = (NoFocus ? Screen.AllScreens.FirstOrDefault(sc => !sc.Primary) ?? Screen.PrimaryScreen : Screen.FromPoint(Cursor.Position)).WorkingArea;
        Width = Math.Min((int)(1320 * k), (int)(wa.Width * 0.9)); Height = Math.Min((int)(840 * k), (int)(wa.Height * 0.9));
        if (NoFocus) { StartPosition = FormStartPosition.Manual; Location = new Point(wa.X + 40, wa.Y + 40); }
        else StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.FromArgb(13, 13, 13);
        FormBorderStyle = FormBorderStyle.Sizable;   // native snap and maximize; the caption is drawn by the page
        minTrack = new Size(Math.Min((int)(720 * k), wa.Width / 2), Math.Min((int)(480 * k), wa.Height / 2));
        string icoPath = Path.Combine(appDir, "app.ico");
        try { Icon = File.Exists(icoPath) ? new Icon(icoPath) : Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }
        // (tests, with their own --data: HWDECK_SCREEN_GONE=a-b, seconds after the start when only the main screen counts as there)
        string[] gone = customData ? (Environment.GetEnvironmentVariable("HWDECK_SCREEN_GONE") ?? "").Split('-') : new string[0];
        if (gone.Length != 2 || !int.TryParse(gone[0], out goneFrom) || !int.TryParse(gone[1], out goneTo)) goneFrom = -1; else goneAt = DateTime.UtcNow;
        RestoreWin();
        ResizeBegin += delegate { moving = true; movedFrom = Bounds; };
        ResizeEnd += delegate { moving = false; if (fitAfterMove) { fitAfterMove = false; FitToScreen(); } SaveWin(Bounds != movedFrom); };   // (a click on the title bar moves nothing)
        Resize += delegate { NoteNormal(); if (WindowState != FormWindowState.Minimized) { restoreMax = WindowState == FormWindowState.Maximized; PostMax(); } };
        Move += delegate { NoteNormal(); };
        Shown += delegate { FitToScreen(); };

        wv = new WebView2();
        wv.Dock = DockStyle.Fill;
        wv.DefaultBackgroundColor = Color.FromArgb(13, 13, 13);
        // the browser cache goes to LocalAppData, never next to the exe (Program Files is read-only); a run with its
        // own --data folder gets its own cache too, so a test instance can't clash with the real one
        wv.CreationProperties = new CoreWebView2CreationProperties { UserDataFolder = customData ? P("WebView2")
            : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), Brand.Name, "WebView2") };
        Controls.Add(wv);
        wv.CoreWebView2InitializationCompleted += OnWvReady;
        HandleCreated += delegate
        {
            // (a copy that never takes the focus never covers anything either: under every window before its first show)
            if (NoFocus) SetWindowPos(Handle, (IntPtr)1 /*HWND_BOTTOM*/, 0, 0, 0, 0, 0x0001 /*NOSIZE*/ | 0x0002 /*NOMOVE*/ | 0x0010 /*NOACTIVATE*/);
            // the size limits for the monitor the window opened on (window.json may put it on another one)
            try
            {
                uint dpi = GetDpiForWindow(Handle);
                var wa2 = Screen.FromHandle(Handle).WorkingArea;
                if (dpi > 0) minTrack = new Size(Math.Min((int)(720 * dpi / 96), wa2.Width / 2), Math.Min((int)(480 * dpi / 96), wa2.Height / 2));
                if (!winAsked.IsEmpty && WindowState == FormWindowState.Normal && Bounds != winAsked) Log("window opened " + WinTxt(Bounds, false) + " at " + dpi + " dpi, not where window.json put it");
            }
            catch { }
            BeginInvoke((Action)FitToScreen);
            if (showAsked) BeginInvoke((Action)ShowWin);
            try
            {
                wv.EnsureCoreWebView2Async(null).ContinueWith(t => { if (t.IsFaulted) Try(() => BeginInvoke((Action)(() => WebViewFailed(t.Exception.GetBaseException())))); });
            }
            catch (Exception ex) { WebViewFailed(ex); }
        };

        // the notification area draws small icons: take the frame made for that size, not a scaled large one
        Icon trayIcon = null;
        try { if (File.Exists(icoPath)) trayIcon = new Icon(icoPath, SystemInformation.SmallIconSize); } catch { }
        tray = new NotifyIcon { Icon = trayIcon ?? Icon ?? SystemIcons.Application, Text = Brand.Name, Visible = true };
        var menu = new ContextMenu();
        menu.MenuItems.Add("Open " + Brand.Name, delegate { ShowWin(); });
        menu.MenuItems.Add(new MenuItem("Restart HWiNFO", delegate { RestartHwinfo(); }) { Enabled = !fake });
        autoItem = new MenuItem("Start with Windows", delegate { SetAutostart(!Autostart()); if (pageReady) SendSettings(); });   // (an open Settings shows it too)
        menu.MenuItems.Add(autoItem);
        menu.Popup += delegate { autoItem.Checked = Autostart(); };
        menu.MenuItems.Add("-");
        menu.MenuItems.Add("Exit", delegate { exiting = true; tray.Visible = false; Application.Exit(); });
        tray.ContextMenu = menu;
        tray.DoubleClick += delegate { ShowWin(); };
        tray.MouseClick += delegate(object s, MouseEventArgs e) { if (e.Button == MouseButtons.Left) ShowWin(); };
        tray.BalloonTipClicked += delegate { ShowWin(); };

        FormClosing += delegate(object s, FormClosingEventArgs e)
        {
            // a quit: the page's saves still waiting (a change made just now) go first, then the quit (11-17)
            if (exiting && !flushDone && !ending && pageReady && e.CloseReason != CloseReason.WindowsShutDown) { e.Cancel = true; FlushThenQuit(); return; }
            SaveWin();
            if (!exiting && e.CloseReason == CloseReason.UserClosing) { e.Cancel = true; HideToTray(); }   // X = to the tray; never veto shutdown
            // Windows asks to end the session: save now, but another app can still cancel it, so the exit mark and
            // the tray wait for WM_ENDSESSION
            else if (!exiting && e.CloseReason == CloseReason.WindowsShutDown) SaveData();
            else { tray.Visible = false; SaveAll(); }
        };
        Application.ApplicationExit += delegate { SaveAll(); };
        AppendLog("alerts.log", AppInfo.Stamp() + "  MARK    app start");

        timer = new Timer { Interval = 250 };
        timer.Tick += OnTick;
        timer.Start();   // history, warnings and games run from the start, page or not
        if (Environment.GetEnvironmentVariable("HWDECK_TRACE") == "1") UiTrace.Start(this, Path.Combine(dataDir, "trace.log"));
        ExtStart();
        // (the headset, after a build's own start, which may block it: never in a test copy (--data, --fake), unless
        // HWDECK_BATT=1 for its own check; a --fake copy with HWDECK_FAKEHS=1 makes one up)
        HsPage.Load();   // (after the build's start: it may turn the mouse on, which the default page goes by)
        bool hsCheck = Environment.GetEnvironmentVariable("HWDECK_BATT") == "1" || Environment.GetEnvironmentVariable("HWDASH_BATT") == "1";
        if (((!fake && !customData) && !Batt.Blocked()) || hsCheck) Batt.Start();
        else if (fake && (Environment.GetEnvironmentVariable("HWDECK_FAKEHS") ?? "0") != "0" && Environment.GetEnvironmentVariable("HWDECK_FAKEHS") != "") Batt.FakeHeadset(Environment.GetEnvironmentVariable("HWDECK_FAKEHS"));
        Log("start " + AppInfo.Run + " (pid " + Process.GetCurrentProcess().Id + (fake ? ", fake " + fakeN : "") + ", data " + dataDir + ")");
    }

    long savedAt;
    bool ended;
    void SaveAll() { try { ExtStop(); } catch { } try { Batt.Stop(); } catch { } Try(() => { if (src.Frames != null) src.Frames.Stop(); }); if (settingsRetry) SaveSettings(); Try(HsPage.Retry); SaveData(); EndMark(); }   // (a trace left running stays until Windows restarts)
    bool FpsWanted { get { return !settings.ContainsKey("gameFps") || true.Equals(settings["gameFps"]); } }   // (on unless turned off, 11-09)

    // ---- extras: a build may add readings (Extra), cell kinds (web\extras.js) and messages of its own ("x.*" both
    // ways); HW Deck itself has none, so these calls compile away ----
    partial void ExtStart();                                            // the end of the constructor: add to src.Extras
    partial void ExtMessage(string t, Dictionary<string, object> m);    // a message from the page whose type starts "x."
    partial void ExtSecond(long now);                                   // once a second, after the history sample
    partial void ExtStop();                                             // quitting or the session ending: save what it keeps
    partial void ExtFeedHidden(ref bool on);                            // the window hidden: on = the page still gets each second (a build that draws elsewhere from them)
    void SaveData()
    {
        long ago = Source.Unix() - savedAt;
        if (ago >= 0 && ago < 5) return;   // the window closing and the app exiting both ask (the clock set back since: saved)
        savedAt = Source.Unix();
        hist.CloseOpen(); hist.Save(true); hist.DropOpen(); games.Flush(); ClosePace();
    }
    void EndMark()
    {
        if (ended) return;
        ended = true; timer.Stop();   // no tick logs anything after the mark
        alerts.Mark("app exit"); WriteAlerts();   // open episodes end now, not at the next start
    }

    // to the tray: WebView2 is told it is hidden too, or it keeps drawing (and animating) for nobody
    void HideToTray()
    {
        SaveWin();
        Try(() => wv.Visible = false);
        Hide();
        if (!true.Equals(settings.ContainsKey("trayHint") ? settings["trayHint"] : null))
        {
            settings["trayHint"] = true; SaveSettings();
            Try(() => tray.ShowBalloonTip(6000, Brand.Name + " is still running", "It keeps checking your lines from here. Click the icon to open it, right-click it to exit.", ToolTipIcon.None));
        }
    }

    static bool Try(Action a) { try { a(); return true; } catch { return false; } }   // settings an older WebView2 runtime may not have
    void WebViewFailed(Exception ex)
    {
        if (wvFailed) return;
        wvFailed = true;
        Log("webview failed: " + ex);
        bool missing = ex is WebView2RuntimeNotFoundException;
        if (MessageBox.Show(Brand.Name + " draws its window with the Microsoft Edge WebView2 Runtime, and it could not start" +
                            (missing ? ": it isn't installed on this PC." : ":\n\n" + (ex != null ? ex.Message : "unknown error")) +
                            "\n\nWindows 11 has it built in; on Windows 10 it may be missing. Open Microsoft's download page?",
                            Brand.Name, MessageBoxButtons.YesNo, MessageBoxIcon.Warning) == DialogResult.Yes)
            Try(() => Process.Start("https://go.microsoft.com/fwlink/p/?LinkId=2124703"));
        exiting = true; tray.Visible = false; Application.Exit();
    }
    void OnWvReady(object s, CoreWebView2InitializationCompletedEventArgs e)
    {
        if (!e.IsSuccess) { WebViewFailed(e.InitializationException); return; }
        var core = wv.CoreWebView2;
        Try(() => browserPid = core.BrowserProcessId);
        // an app, not a browser: no dev tools (unless a test asked for the debug port), no browser keys (print, find,
        // reload), no autofill, no zoom, nothing dropped or clicked can take the page somewhere else
        bool debug = (Environment.GetEnvironmentVariable("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS") ?? "").Contains("remote-debugging");
        // the title bar is NOT a css app-region: WebView2 applies those regions to its windows on this thread after every
        // layout change, and while views were switched that took this thread for seconds (no ticks: the clock froze and
        // skipped seconds). The page asks for the drag instead (Win "drag"). HWDECK_NONCLIENT=1 turns regions back on
        // (diagnostics)
        nonClient = Environment.GetEnvironmentVariable("HWDECK_NONCLIENT") == "1" && Try(() => core.Settings.IsNonClientRegionSupportEnabled = true);   // css app-region: drag = the window caption (else the page asks for a drag)
        Try(() => core.Settings.IsStatusBarEnabled = false);
        Try(() => core.Settings.IsZoomControlEnabled = false);
        Try(() => core.Settings.AreDefaultContextMenusEnabled = false);
        Try(() => core.Settings.AreDevToolsEnabled = debug);
        Try(() => core.Settings.AreBrowserAcceleratorKeysEnabled = false);
        Try(() => core.Settings.IsGeneralAutofillEnabled = false);
        Try(() => core.Settings.IsPasswordAutosaveEnabled = false);
        Try(() => core.Settings.IsPinchZoomEnabled = false);
        Try(() => core.Settings.IsSwipeNavigationEnabled = false);
        Try(() => wv.AllowExternalDrop = false);
        core.NavigationStarting += delegate(object s2, CoreWebView2NavigationStartingEventArgs ev)
        {
            if (!ev.Uri.StartsWith("https://hwdeck.example/", StringComparison.OrdinalIgnoreCase)) ev.Cancel = true;
        };
        core.NewWindowRequested += delegate(object s2, CoreWebView2NewWindowRequestedEventArgs ev) { ev.Handled = true; };
        Try(() => core.DownloadStarting += delegate(object s2, CoreWebView2DownloadStartingEventArgs ev) { ev.Cancel = true; });
        // not a .local name: those wait for a network name lookup before the page can load
        core.SetVirtualHostNameToFolderMapping("hwdeck.example", Path.Combine(appDir, "web"), CoreWebView2HostResourceAccessKind.DenyCors);
        core.WebMessageReceived += OnMsg;
        core.ProcessFailed += delegate(object s2, CoreWebView2ProcessFailedEventArgs ev)
        {
            Log("webview process failed: " + ev.ProcessFailedKind);
            // the page's process died: load it again; the browser itself died: only a new start helps; the GPU process
            // comes back by itself, but one that came back while the graphics driver was being swapped (a driver update
            // or reset) can leave the page drawn on the CPU, at a few fps, until the browser starts again: a new start
            // once that settles (MaybeGpuRestart); the rest (utility processes) come back by themselves
            if (ev.ProcessFailedKind == CoreWebView2ProcessFailedKind.RenderProcessExited || ev.ProcessFailedKind == CoreWebView2ProcessFailedKind.RenderProcessUnresponsive)
                Try(() => { pageReady = false; wv.CoreWebView2.Reload(); });
            else if (ev.ProcessFailedKind == CoreWebView2ProcessFailedKind.GpuProcessExited && !exiting && !ending)
            { gpuLost = true; gpuLostAt = Environment.TickCount; }   // (each new loss pushes the start back)
            else if (ev.ProcessFailedKind == CoreWebView2ProcessFailedKind.BrowserProcessExited && !exiting && !ending)   // at a sign-out Windows may end the browser first
                Try(() =>
                {
                    // (a browser that keeps dying: after the third time within minutes, no more starts, it says so)
                    int next = NextRelaunch();
                    if (next > 2) { Log("the page's browser keeps closing: not started again"); exiting = true; tray.Visible = false; MessageBox.Show(Brand.Name + "'s page keeps closing (its WebView2 browser stopped " + next + " times in a few minutes), so " + Brand.Name + " stopped. Start it again later, or repair the Microsoft Edge WebView2 Runtime in Settings, Apps.", Brand.Name, MessageBoxButtons.OK, MessageBoxIcon.Warning); Application.Exit(); return; }
                    Relaunch(next);
                });
        };
        // the page's files changed (an update): WebView2 may keep serving the old ones from its cache for a while (the
        // folder mapping sends no cache headers), so its disk cache is cleared once before the page loads
        string stamp = PageStamp(), seen = settings.ContainsKey("pageStamp") ? settings["pageStamp"] as string : null;
        Action go = () => core.Navigate("https://hwdeck.example/index.html");
        if (stamp == seen) { go(); return; }
        Action keep = () => { settings["pageStamp"] = stamp; SaveSettings(); };
        try { core.Profile.ClearBrowsingDataAsync(CoreWebView2BrowsingDataKinds.DiskCache).ContinueWith(t => Try(() => BeginInvoke((Action)(() => { if (t.Status == System.Threading.Tasks.TaskStatus.RanToCompletion) keep(); go(); })))); }
        catch { keep(); go(); }   // a WebView2 runtime without it: load as before (and don't try again every start)
    }
    // the page's files as they are now: names, sizes and times
    string PageStamp()
    {
        try { return string.Join("|", Directory.GetFiles(Path.Combine(appDir, "web")).OrderBy(f => f).Select(f => { var i = new FileInfo(f); return i.Name + ":" + i.Length + ":" + i.LastWriteTimeUtc.Ticks; })); }
        catch { return ""; }
    }

    // (11-17, test batch 2002) the page sends every save it still holds (a change of the last 300 ms) and answers 'flushed'
    void FlushPage() { if (pageReady) Post(new Dictionary<string, object> { { "t", "flush" } }); }
    void FlushThenQuit()
    {
        if (flushAsked) return; flushAsked = true;
        var t = new Timer { Interval = 800 }; t.Tick += delegate { t.Stop(); t.Dispose(); QuitFlushed(); }; t.Start();   // (a page that never answers)
        FlushPage();
    }
    void QuitFlushed() { if (flushDone) return; flushDone = true; Application.Exit(); }
    void Post(Dictionary<string, object> m) { try { string j = json.Serialize(m); long a = UiTrace.Now(); wv.CoreWebView2.PostWebMessageAsJson(j); if (UiTrace.on) UiTrace.Took("post " + m["t"] + " " + j.Length + " B", a); } catch { } }
    static Dictionary<string, object> Msg(string t) { return new Dictionary<string, object> { { "t", t } }; }

    void OnMsg(object s, CoreWebView2WebMessageReceivedEventArgs e)
    {
        if (!(e.Source ?? "").StartsWith("https://hwdeck.example/", StringComparison.OrdinalIgnoreCase)) return;   // only our own page
        Dictionary<string, object> m;
        try { m = json.Deserialize<Dictionary<string, object>>(e.WebMessageAsJson); } catch { return; }
        if (m == null) return;
        string t = m.ContainsKey("t") ? m["t"] as string : null;
        try
        {
            switch (t)
            {
                case "ready": pageReady = true; sentVersion = -1; subCells.Clear(); subRows.Clear(); lgLen = -2; SendState(); PostMax(); force = true; OnTick(null, null); break;
                case "sub": Subscribe(m); break;
                case "save":
                    {
                        string f = m["file"] as string;
                        if (f == null || !PageFile.IsMatch(f)) break;
                        // (a view save made before the page got the view it shows now: that one would go over it)
                        if (f == "state" && m.ContainsKey("gen") && Convert.ToInt64(m["gen"]) != stateGen) { Log("not saving state: made before the page got its view"); break; }
                        bool saved = false;
                        try { saved = SaveFile(f, m["data"]); }
                        catch (Exception ex)
                        {
                            // (the view: the page is asked for it again in 5 s, until it goes in; one toast and log line for the run)
                            if (f != "state" || !stateFailing) { Log("saving " + f + " failed: " + ex.Message); var r = Msg("toast"); r["text"] = "Couldn't save the layout: " + (ex is IOException || ex is UnauthorizedAccessException ? "its file can't be written now" : ex.Message) + (f == "state" ? ", trying again" : ""); Post(r); }
                            if (f == "state") { stateFailing = true; stateRetryAt = Source.Unix() + 5; }
                            // (a slot: the page gets it as it is on disk, so it stops taking the view as saved there, 11-06)
                            else
                            {
                                string fn = f.Replace('/', '\\');
                                var back = new Dictionary<string, object>(); back[(f[f.Length - 1] - '1').ToString()] = ReadFile(fn, false, 1);
                                if (!heldFiles.Contains(fn)) { var rs = Msg("slots"); rs["slots"] = back; Post(rs); }   // (held: the Tick sends it once free, as at the start)
                            }
                        }
                        // (a slot another program held when the page started isn't saved over: said so; the view's start toast says it for state)
                        if (!saved && f != "state" && heldFiles.Contains(f.Replace('/', '\\'))) { var r = Msg("toast"); r["text"] = "That slot is open in another program, like a sync or a backup tool. Save again in a moment"; Post(r); }
                        // (the warnings and game reports follow the view as written: not one that was only refused)
                        if (f == "state" && saved && stateFailing) { stateFailing = false; stateRetryAt = 0; Log("state saved after all"); }
                        if (f == "state" && saved) { var d = m["data"] as Dictionary<string, object>; layout = d != null && d.ContainsKey("L") ? d["L"] : null; RefreshRules(); }
                    }
                    break;
                case "hist":
                    {
                        string key = m["key"] as string, range = m["range"] as string;
                        var h = hist.Range(key, range);
                        // the bottleneck: the share of each minute (block) each call held (an average of the calls means nothing)
                        if (key == Bottleneck.Key) for (int i = 0; i < 3; i++) h["s" + "gcf"[i]] = hist.Range(Bottleneck.ShareKeys[i], range)["avg"];
                        h["t"] = "hist"; Post(h);
                    }
                    break;
                case "lastval":   // (readings of the layout HWiNFO isn't sharing now: when each last had a value, 11-08)
                    {
                        long lvNow = Source.Unix(); var lvAt = new Dictionary<string, object>();
                        var lvKs = m.ContainsKey("keys") ? m["keys"] as System.Collections.ArrayList : null;
                        if (lvKs != null) foreach (var lvO in lvKs.Cast<object>().Take(500)) { var lvK = lvO as string; if (lvK != null) lvAt[lvK] = hist.LastAt(lvK, lvNow); }
                        var lvMsg = Msg("lastval"); lvMsg["at"] = lvAt; lvMsg["since"] = hist.Since(lvNow); Post(lvMsg);
                    }
                    break;
                case "alerts": SendLog("alerts.log", "alerts"); break;
                case "alerts:clear": Wipe("alerts.log"); SendCleared("alerts"); SendSettings(); break;
                case "games": SendLog("games.log", "games"); break;
                // the bins (11-02): what Delete, Keep or a move set aside, for its popup's Bin view; and lines moved,
                // exactly as they are, from a log into its bin or back (put in among the log's lines by time, once each)
                case "games:bin": SendLog("games.log.bak", "gamesBin"); break;
                case "alerts:bin": SendLog("alerts.log.bak", "alertsBin"); break;
                case "log:move":
                    {
                        string which = m.ContainsKey("log") ? m["log"] as string : null, name = which == "games" ? "games.log" : which == "alerts" ? "alerts.log" : null;
                        var arr = m.ContainsKey("lines") ? m["lines"] as System.Collections.ArrayList : null;
                        bool toLog = m.ContainsKey("to") && "log".Equals(m["to"]);
                        if (name == null || arr == null) break;
                        var lines = arr.Cast<object>().Select(o => o as string).Where(l => !string.IsNullOrEmpty(l)).ToList();
                        var old = toLog ? OlderThanKept(which) : null; int held = 0, n = 0; string fail = null;
                        if (old != null) { held = Count(name, lines.Where(l => old(l))); lines = lines.Where(l => !old(l)).ToList(); }
                        try
                        {
                            List<string> did; n = MoveLines(name, lines, toLog, out did);
                            // (the page's count when all it asked for moved: a crossing an exit ended and the red after it are two
                            // there, the marks between them staying in the log)
                            long asked = m.ContainsKey("n") ? Games.Long(m["n"]) : 0; if (asked > 0 && asked < 100000 && held == 0 && did.Count > 0 && did.Count == lines.Count) n = (int)asked;
                            if (which == "games" && did.Count > 0) games.Moved(did, toLog);   // (only what moved: a line the page had and the log no longer has is someone else's now)
                        }
                        catch (Exception ex) { fail = ex.Message; Log("log:move failed: " + ex.Message); }   // (the page hears it, and gets the logs as they are)
                        SendLog(name, which); SendLog(name + ".bak", which + "Bin"); SendSettings();
                        if (fail == null && m.ContainsKey("quiet") && true.Equals(m["quiet"])) break;
                        var r = Msg("toast"); Func<int, string> what = k => which == "games" ? (k == 1 ? "1 session" : k + " sessions") : (k == 1 ? "1 warning" : k + " warnings");
                        string kept = held > 0 ? what(held) + " older than the days you keep stayed in the bin" : null;
                        r["text"] = fail != null ? "Couldn't move it: " + fail : n == 0 ? (kept ?? "Nothing moved: the list changed meanwhile") : (toLog ? what(n) + " back from the bin" : what(n) + " moved to the bin") + (kept != null ? ", " + kept : "");
                        r["undo"] = n > 0 && fail == null; r["moved"] = fail != null ? 0 : n; Post(r);   // (moved 0: the page drops the step it kept for it)
                    }
                    break;
                // a bin's row deleted permanently (11-03): its exact lines leave the bin's file; nothing keeps a copy
                case "log:purge":
                    {
                        string which = m.ContainsKey("log") ? m["log"] as string : null, name = which == "games" ? "games.log" : which == "alerts" ? "alerts.log" : null;
                        var arr = m.ContainsKey("lines") ? m["lines"] as System.Collections.ArrayList : null;
                        if (name == null || arr == null) break;
                        var lines = arr.Cast<object>().Select(o => o as string).Where(l => !string.IsNullOrEmpty(l)).Distinct().ToList();
                        int n = 0; string fail = null; var did = new List<string>();
                        try
                        {
                            n = PurgeLines(name, lines, out did);
                            long asked = m.ContainsKey("n") ? Games.Long(m["n"]) : 0; if (asked > 0 && asked < 100000 && did.Count > 0 && did.Count == lines.Count) n = (int)asked;   // (the page's count, as its rows count them)
                        }
                        catch (Exception ex) { fail = ex.Message; Log("log:purge failed: " + ex.Message); }
                        SendLog(name + ".bak", which + "Bin");
                        var r = Msg("toast"); Func<int, string> what = k => which == "games" ? (k == 1 ? "1 session" : k + " sessions") : (k == 1 ? "1 warning" : k + " warnings");
                        r["text"] = fail != null ? "Couldn't delete it: " + fail : did.Count == 0 ? "Nothing deleted: the list changed meanwhile" : what(Math.Max(1, n)) + " deleted permanently";
                        r["gone"] = fail == null ? did : new List<string>(); Post(r);   // (the page drops undo steps that only held these; a failed write deleted nothing)
                    }
                    break;
                case "gamesLive": gamesLive = true.Equals(m["on"]); if (gamesLive) PostLive(); break;   // the sessions popup opened or closed
                case "games:clear": lock (games.LogLock) Wipe("games.log"); games.Forget(); SendCleared("games"); SendSettings(); break;
                // a session of your own: start, stop, a new name while it runs
                case "rec":
                    {
                        string act = m.ContainsKey("act") ? m["act"] as string : null; long st = m.ContainsKey("start") ? Games.Long(m["start"]) : 0;
                        if (act == "start") { string why = games.StartCustom(m.ContainsKey("name") ? m["name"] : null); if (why != null) { var r = Msg("toast"); r["text"] = why; Post(r); } }
                        else if (act == "stop") { if (!games.StopCustom(st)) { var r = Msg("toast"); r["text"] = "Under 10 seconds, so it wasn't kept"; Post(r); } SendLog("games.log", "games"); }
                        else if (act == "name") games.RenameCustom(st, m.ContainsKey("name") ? m["name"] : null);
                        force = true;   // the next tick says what runs
                    }
                    break;
                // one session in the log: deleted (kept in games.log.bak), or one of your own renamed
                case "gedit":
                    {
                        string act = m["act"] as string, game = m["game"] as string, name = Games.CleanName(m.ContainsKey("name") ? m["name"] : null);
                        long st = Games.Long(m["start"]), en = Games.Long(m["end"]);
                        string at = "\"start\":" + st.ToString(System.Globalization.CultureInfo.InvariantCulture);
                        if (act == "del") games.Forget(st, game);   // (deleted: not taken back by a merge)
                        try { games.EditLog(o => !Games.Is(o, st, en, game) ? 0 : act == "del" ? 1 : act == "name" && name != null && o.ContainsKey("custom") ? Rename(o, name) : 0, line => line.Contains(at), true); }
                        finally { SendLog("games.log", "games"); }   // (the page shows the log as it is, whatever happened)
                    }
                    break;
                // how many days the sessions and the warnings are kept
                case "keep":
                    if (m.ContainsKey("games")) SetKeep("game", m["games"]);
                    if (m.ContainsKey("warns")) SetKeep("warn", m["warns"]);
                    if (settings.ContainsKey("gameDays") && settings.ContainsKey("warnDays")) settings.Remove("daysUnknown");   // (both known again; until then the other log is left whole)
                    SaveSettings(); TrimAlerts(); TrimGames(); SendSettings();
                    SendLog("games.log", "games");
                    break;
                case "gameMerge":
                    {
                        object mo = m.ContainsKey("min") ? m["min"] : null; long v = mo == null ? long.MinValue : Games.Long(mo);
                        if (v != long.MinValue) { settings["gameMerge"] = (int)Math.Max(0, Math.Min(240, v)); games.MergeWithin = MergeMins() * 60; SaveSettings(); }
                        SendSettings();
                    }
                    break;
                case "autostart": SetAutostart(true.Equals(m["on"])); SendSettings(); break;
                case "restartHwinfo": RestartHwinfo(); break;
                case "keepSharing": SetKeepSharing(true.Equals(m["on"])); break;
                case "getSettings": SendSettings(); break;
                case "gameFps": SetGameFps(true.Equals(m["on"])); break;
                case "hs.get": case "hs.set": case "hs.play":   // (the Headset cell's popup, 11-13: the base's page, his changes, an animation)
                    { var hr = HsPage.Message(t.Substring(3), m); if (t == "hs.set") Batt.Redraw(); if (hr != null) { var hv = Msg("hsv"); foreach (var kv in hr) hv[kv.Key] = kv.Value; Post(hv); } break; }
                case "hs.power": if (!fake && !customData) Batt.SetScreen(true.Equals(m["on"])); break;
                case "hs.screen": { var sm = m.ContainsKey("m") ? m["m"] as string : null; if (!fake && !customData) Batt.SetScreen(sm, true); else if (fake) Batt.SetScreen(sm, false); break; }   // (the Headset tab's Screen: Off, Original, Custom, his 11-14 pick; a --fake copy has no base station: kept in memory only)
                case "hs.setting": Batt.Setting(m, !fake && !customData); break;   // (the headset's own settings, the Headset tab; a --fake copy keeps them in memory)
                case "hs.setlook": Batt.SettingsLook(); break;
                case "hs.refresh": if (!fake && !customData) Batt.Refresh(); break;   // (his 11-14 "add a refresh button to unbug in case it happens")
                case "hs.export": HsExport(m); break;   // (a headset theme to a file, for another PC; 11-14)
                case "hs.import": HsImport(m); break;
                case "hs.bright": { object bv; int bi; if (m.TryGetValue("v", out bv) && bv != null && int.TryParse(Convert.ToString(bv, System.Globalization.CultureInfo.InvariantCulture), out bi)) Batt.SetBright(bi, !fake && !customData); break; }   // (the base's brightness slider: sent when let go)   // (HW Deck on the base's screen, or the base's own)
                case "netTest": settings["netTest"] = true.Equals(m["on"]); SaveSettings(); Net.SetOn(true.Equals(m["on"])); break;   // (the speed test's switch, 2.4.8)
                case "net": Net.Act(m.ContainsKey("do") ? m["do"] as string : null, m.ContainsKey("every") && m["every"] != null ? Convert.ToString(m["every"], System.Globalization.CultureInfo.InvariantCulture) : null); break;   // (Test now, Test every)
                case "openData": Process.Start("explorer.exe", "\"" + dataDir + "\""); break;
                case "updates": settings["updates"] = true.Equals(m["on"]); updNext = 0; SaveSettings(); SendSettings(); break;
                case "updCheck": updAsked = true; if (!updBusy) { updNext = 0; MaybeCheckUpdate(Source.Unix()); } break;   // (one under way: its answer is this one)
                case "openRelease": OpenRelease(); break;
                case "updateNow": UpdateNow(); break;
                case "drag": Win("drag", m.ContainsKey("end")); break;
                case "export": Export(m["data"], m["name"] as string); break;
                case "import": Import(Convert.ToInt32(m["slot"])); break;
                case "win": Win(m["a"] as string); break;
                case "flushed": if (flushAsked) BeginInvoke((Action)QuitFlushed); break;
                case "exit": exiting = true; tray.Visible = false; Application.Exit(); break;   // a clean quit (tests): history and logs get saved
                // tests, made-up data only: a game in place of the processes, a reading held at a value
                case "estSeen": if (settings.Remove("estNote")) SaveSettings(); break;   // (the note's X, or Show sessions)
                case "notesSeen": { string v = m.ContainsKey("v") ? m["v"] as string : null, was = settings.ContainsKey("notesSeen") ? settings["notesSeen"] as string : null;
                    if (v != null && Ver(v) != null && (was == null || Newer(v, was)) && !Newer(v, AppInfo.Run)) { settings["notesSeen"] = v; SaveSettings(); } break; }
                case "fakeGame": if (fake) games.Pretend(m.ContainsKey("game") ? m["game"] as string : null, m.ContainsKey("front") && true.Equals(m["front"])); break;
                case "fakePin": if (fake) ((FakeSource)src.Inner).Pin(m["key"] as string, m["v"] == null ? double.NaN : Convert.ToDouble(m["v"], System.Globalization.CultureInfo.InvariantCulture)); break;
                case "fakeFrames": if (fake) { Func<string, double> d = k => m.ContainsKey(k) && m[k] != null ? Convert.ToDouble(m[k], System.Globalization.CultureInfo.InvariantCulture) : 0; ((FakeSource)src.Inner).SetFrames(d("fps"), d("jitter"), d("swing"), m.ContainsKey("stable") && true.Equals(m["stable"])); } break;
                default: if (t != null && t.StartsWith("x.")) ExtMessage(t, m); break;
            }
        }
        catch (Exception ex) { Log("message " + t + " failed: " + ex.Message); }
    }

    // ---- files: state.json (working layout, active slot, view, edit mode) and slots\slotN.json, written whole through
    // a temp file so a crash mid-write can't leave half a layout ----
    static readonly Regex PageFile = new Regex(@"^(?:state|slots/slot[1-5])\z");   // what the page may write; settings.json is the host's alone
    static bool CanOpen(string p) { try { if (!File.Exists(p)) return true; using (var f = new FileStream(p, FileMode.Open, FileAccess.Read, FileShare.Read)) { var b = new byte[4096]; while (f.Read(b, 0, b.Length) > 0) { } return true; } } catch { return false; } }   // (to the end: one that opens but can't be read all through isn't free)
    // a view save that failed (another program's handle on state.json): asked of the page again at this time, unix s
    bool stateFailing; long stateRetryAt;
    // settings.json written; one that failed (another program's handle) is logged once and written again every 5 s and
    // at the exit, so a setting changed then isn't lost
    volatile bool settingsRetry; bool saveToastSaid;
    void SaveSettings()
    {
        try { if (SaveFile("settings", settings) && settingsRetry) { settingsRetry = false; Log("settings saved after all"); } }
        catch (Exception ex) { if (!settingsRetry) Log("saving settings failed (trying again): " + ex.Message); settingsRetry = true; }
    }
    bool SaveFile(string name, object data)   // false: not written (held)
    {
        string p = P(name.Replace('/', '\\') + ".json"), tmp = p + ".tmp";
        if (name == "settings" && settingsHeld) return false;   // (defaults this run: the good file stays)
        if (heldFiles.Contains(name.Replace('/', '\\'))) { if (heldSaid.Add(name)) Log("not saving " + name + ": the page never got it (held by another program)"); return false; }
        if (data == null) { if (File.Exists(p)) File.Delete(p); return true; }
        var bytes = new UTF8Encoding(false).GetBytes(json.Serialize(data));
        using (var fs = new FileStream(tmp, FileMode.Create, FileAccess.Write, FileShare.None)) { fs.Write(bytes, 0, bytes.Length); fs.Flush(true); }   // on disk before it replaces the old one
        if (File.Exists(p)) File.Replace(tmp, p, name == "state" ? p + ".bak" : null); else File.Move(tmp, p);
        return true;
    }
    // a file that can't be read is logged; the working view (keep) is moved aside instead of being overwritten by the first edit
    // keep: a damaged file is moved aside (a held one, another program reading or syncing it, isn't: it is tried again
    // for 2 s, then left for the page's start to read)
    // a view or slot still held when the page asks for it: the page gets nothing for it, so nothing is saved over it, and
    // it is sent again once it can be read (Tick)
    readonly HashSet<string> heldFiles = new HashSet<string>(), heldSaid = new HashSet<string>();
    readonly Dictionary<string, long> heldAt = new Dictionary<string, long>();   // (held since: unix seconds)
    readonly HashSet<string> gaveUpNow = new HashSet<string>();   // (a slot taken as damaged, not sent to the page yet)
    readonly List<string> goneNotes = new List<string>();   // (the notes of files taken as damaged, not said yet)
    long stateGen;   // (which view the page got last: a state save made before it is dropped)
    // a file still unreadable after 2 minutes is damaged, not held (a bad sector, permissions from another install): it
    // is moved aside, the view starts empty as when it can't be parsed, a slot comes in empty, and saving goes on. Only
    // once the move worked: one a program really holds can't be moved, so it stays held and nothing is saved over it
    bool GiveUp(string n)
    {
        if (CanOpen(P(n + ".json"))) return false;   // (it reads now: nothing damaged, the re-sends after this read it)
        string bad = n + ".json.bad-" + DateTime.Now.ToString("yyyyMMdd-HHmmss", System.Globalization.CultureInfo.InvariantCulture);
        try { File.Move(P(n + ".json"), P(bad)); }
        catch { heldAt[n] = Source.Unix(); return false; }   // (again in 2 minutes)
        heldFiles.Remove(n); heldAt.Remove(n); heldSaid.Remove(n.Replace('\\', '/'));
        Log("reading " + n + " still failed after 2 minutes: taken as damaged, moved aside as " + bad);
        // (its note: one toast with the others now if the window is open, else when it opens)
        if (n == "state") goneNotes.Add("Your view couldn't be read, so its file is set aside as " + bad + " in your files (Settings). The view you see now is kept.");
        else { gaveUpNow.Add(n); goneNotes.Add("Slot " + n.Substring(n.Length - 1) + " couldn't be read, so it is empty now. The old file is kept as " + bad.Replace('\\', '/') + " in your files (Settings)."); }
        return true;
    }
    object ReadFile(string name, bool keep = false, int tries = 10)
    {
        string p = P(name + ".json");
        string text = null;
        bool page = name == "state" || name.StartsWith("slots\\");
        for (int i = 0; ; i++)
            try { if (!File.Exists(p)) { heldFiles.Remove(name); heldAt.Remove(name); return null; } text = File.ReadAllText(p); break; }
            catch (IOException ex) { if (i >= tries - 1) { Log("reading " + name + " failed (held): " + ex.Message); if (page) { heldFiles.Add(name); if (!heldAt.ContainsKey(name)) heldAt[name] = Source.Unix(); } return null; } System.Threading.Thread.Sleep(200); }
            catch (UnauthorizedAccessException ex) { if (i >= tries - 1) { Log("reading " + name + " failed (held): " + ex.Message); if (page) { heldFiles.Add(name); if (!heldAt.ContainsKey(name)) heldAt[name] = Source.Unix(); } return null; } System.Threading.Thread.Sleep(200); }
        heldFiles.Remove(name); heldSaid.Remove(name.Replace('\\', '/')); heldAt.Remove(name);
        try { return json.DeserializeObject(text); }
        catch (Exception ex)
        {
            Log("reading " + name + " failed: " + ex.Message);
            if (keep)
                try { string bad = name + ".json.bad-" + DateTime.Now.ToString("yyyyMMdd-HHmmss", System.Globalization.CultureInfo.InvariantCulture); File.Move(p, P(bad)); stateBad = bad; }
                catch { }
            // (a slot too, 11-06: it came in empty, so the next save into it would have gone over the old file for good)
            else if (name.StartsWith("slots\\"))
                try
                {
                    string bad = name + ".json.bad-" + DateTime.Now.ToString("yyyyMMdd-HHmmss", System.Globalization.CultureInfo.InvariantCulture); File.Move(p, P(bad));
                    goneNotes.Add("Slot " + name.Substring(name.Length - 1) + " couldn't be read, so it is empty now. The old file is kept as " + bad.Replace('\\', '/') + " in your files (Settings).");
                }
                catch { }
            return null;
        }
    }
    // maximized or not, for the page: maximized, its edges aren't resize borders (the top one drags the title bar)
    void PostMax() { if (!pageReady || !IsHandleCreated) return; var r = Msg("winMax"); r["max"] = IsZoomed(Handle); Post(r); }   // (Windows' word: WindowState lags a maximize from the title bar)
    bool gamesLive;   // the page's sessions popup is open
    void PostLive() { var r = Msg("gameNow"); r["s"] = games.LiveLine(); Post(r); }
    void SendState(bool again = false)   // (again: the Tick's re-send of a held view, which posts nothing while it is still held)
    {
        var slots = new List<object>();
        gaveUpNow.Clear();   // (all five go out here)
        var heldBefore = new HashSet<int>(); for (int i = 0; i < 5; i++) if (heldFiles.Contains("slots\\slot" + (i + 1))) heldBefore.Add(i);
        // (a file still held from before: one try, the 2 s of retries were spent already)
        for (int i = 1; i <= 5; i++) slots.Add(ReadFile("slots\\slot" + i, false, heldFiles.Contains("slots\\slot" + i) ? 1 : 10));
        var r = Msg("state");
        var st = ReadFile("state", true, heldFiles.Contains("state") ? 1 : 10);   // (a damaged one is kept aside, as at the start)
        // (the view the page gets is the one the warnings and game reports follow: one held at the start comes in here)
        if (again && heldFiles.Contains("state"))   // (still unreadable: the page keeps what it has, no reset every 5 s; slots freed meanwhile go alone)
        {
            var freed = new Dictionary<string, object>();
            for (int i = 0; i < 5; i++) if (heldBefore.Contains(i) && !heldFiles.Contains("slots\\slot" + (i + 1))) freed[i.ToString()] = slots[i];
            if (freed.Count > 0) { var rf = Msg("slots"); rf["slots"] = freed; Post(rf); }
            return;
        }
        r["gen"] = ++stateGen;   // (only for a view that goes out: the page saves with the number it got)
        if (!heldFiles.Contains("state")) { var sd = st as Dictionary<string, object>; layout = sd != null && sd.ContainsKey("L") ? sd["L"] : null; RefreshRules(); }
        var held = new List<object>(); for (int i = 0; i < 5; i++) if (heldFiles.Contains("slots\\slot" + (i + 1))) held.Add(i);
        r["held"] = held;   // (the slots another program holds: a missing or damaged one is empty for good)
        r["state"] = st; r["slots"] = slots; r["fake"] = fake; r["dataDir"] = dataDir; r["version"] = AppInfo.Run; r["pc"] = Environment.MachineName;
        r["nonClient"] = nonClient;
        r["noStarter"] = OtherArgs.Any(a => a.Equals("--no-starter", StringComparison.OrdinalIgnoreCase));   // (tests: no Starter, no note about it; kept on a restart)
        r["stateHeld"] = heldFiles.Contains("state");   // (its view comes later: no Starter built over it meanwhile)
        r["stateBad"] = stateBad != null;   // (a view that couldn't be read and was set aside: not a new user, and its note stays in sight)
        r["ext"] = File.Exists(Path.Combine(appDir, "web", "extras.js")); r["brand"] = Brand.Name; r["updatable"] = Brand.Updates;
        Post(r);
        if (stateBad != null && wasShowing) { var tb = Msg("toast"); tb["text"] = "Your view couldn't be read, so it starts empty. The old file is kept as " + stateBad + " in your files (Settings)."; tb["ms"] = 15000; Post(tb); stateBad = null; }
        PostHeld();
        SendSettings();
    }
    // only the slots that were held and read now (index: layout); the others stay as the page has them
    // a view held when the page asked for it: said whenever the window shows while it lasts (a start in the tray too)
    const string HeldNote = "Your view is open in another program (a sync or a backup tool), so it isn't shown yet. It comes in once that program lets go, and nothing is saved over it until then.";
    void PostHeld() { if (!heldFiles.Contains("state")) return; var t = Msg("toast"); t["text"] = HeldNote; t["ms"] = 15000; Post(t); }
    void SendSlots()
    {
        var slots = new Dictionary<string, object>();
        for (int i = 1; i <= 5; i++)
        {
            string n = "slots\\slot" + i;
            if (gaveUpNow.Remove(n)) { slots[(i - 1).ToString()] = null; continue; }   // (damaged: empty)
            if (!heldFiles.Contains(n) || !CanOpen(P(n + ".json"))) continue;
            var d = ReadFile(n, false, 1);
            if (!heldFiles.Contains(n)) slots[(i - 1).ToString()] = d;
        }
        if (slots.Count == 0) return;
        var r = Msg("slots"); r["slots"] = slots; Post(r);
    }
    void SendSettings(bool keepDone = false, bool fpsDone = false)   // (keepDone, fpsDone: the answer to the page's keepSharing, gameFps)
    {
        var r = Msg("settings");
        r["autostart"] = Autostart(); r["hwinfo"] = settings.ContainsKey("hwinfo") ? settings["hwinfo"] : null;
        keepLast = 0; keepOld = false; r["keep"] = KeepSharing(); r["keepNote"] = KeepNote(); r["keepBusy"] = keepBusy; r["keepDone"] = keepDone;   // (until done, the page shows what was asked)
        r["fps"] = src.Frames != null && FpsWanted; r["fpsState"] = FpsState(); r["fpsBusy"] = fpsBusy; r["fpsDone"] = fpsDone;
        r["updates"] = UpdatesOn();
        r["gameDays"] = DaysSet("gameDays") ? KeepDays("gameDays") : (object)null; r["warnDays"] = DaysSet("warnDays") ? KeepDays("warnDays") : (object)null;   // (null: not set, nothing cut)
        r["gameMerge"] = MergeMins();
        int est = 0; try { if (settings.ContainsKey("estNote")) est = Convert.ToInt32(settings["estNote"]); } catch { }
        r["estNote"] = est;   // (sessions from before 2.0.1 this update worked out again: the page's note, until its X)
        r["notesSeen"] = settings.ContainsKey("notesSeen") ? settings["notesSeen"] as string : AppInfo.Run;   // (the update notes seen: up to this version)
        
        string latest = settings.ContainsKey("updLatest") ? settings["updLatest"] as string : null;
        r["latest"] = UpdatesOn() && Newer(latest, AppInfo.Version) ? latest : null;
        r["canUpdate"] = Installed() != null;   // (installed with the msi: its Update button installs the new one)
        Post(r);
    }

    // ---- new version check: as soon as the app starts, then once a day while it runs, asks GitHub for the latest
    // release; nothing else is sent. No answer (no network yet, as at sign-in): again in 2 minutes, 3 times, then hourly ----
    const string ReleasesApi = "https://api.github.com/repos/RodrigoArsenioo/hwdeck/releases/latest";
    // (11-17 test batch 1008: a --fake copy with HWDECK_UPDTEST=<base url> checks <base>/latest instead; the real app never)
    string UpdTest { get { if (!fake) return null; var u = Environment.GetEnvironmentVariable("HWDECK_UPDTEST"); return string.IsNullOrEmpty(u) ? null : u.TrimEnd('/'); } }
    const string ReleasesPage = "https://github.com/RodrigoArsenioo/hwdeck/releases/";
    long updNext;
    int updMissed;
    volatile bool updBusy, updLogged;
    bool updAsked;   // (Settings' check now: the page gets how it went, updDone)
    bool UpdatesOn() { return Brand.Updates && !settingsHeld && (!settings.ContainsKey("updates") || !false.Equals(settings["updates"])); }   // (held: maybe turned off, so off)
    static int[] Ver(string s)
    {
        var m = Regex.Match(s ?? "", @"^v?(\d+)\.(\d+)\.(\d+)$");
        return m.Success ? new[] { int.Parse(m.Groups[1].Value), int.Parse(m.Groups[2].Value), int.Parse(m.Groups[3].Value) } : null;
    }
    // the oldest version started in app.log and app.log.old ("  start 2.4.1 (pid ..."): where this install began, or the
    // oldest it went back to; null: none
    static string OldestStartIn(string appLog)
    {
        string low = null;
        foreach (var f in new[] { appLog + ".old", appLog })
        {
            try
            {
                if (!File.Exists(f)) continue;
                foreach (var l in File.ReadLines(f))
                {
                    int i = l.IndexOf("  start ", StringComparison.Ordinal); if (i <= 0) continue;
                    string v = l.Substring(i + 8).Split(' ')[0];
                    if (Ver(v) != null && (low == null || Newer(low, v))) low = v;
                }
            }
            catch { }
        }
        return low;
    }
    static bool Newer(string a, string b)
    {
        int[] x = Ver(a), y = Ver(b);
        if (x == null || y == null) return false;
        for (int i = 0; i < 3; i++) if (x[i] != y[i]) return x[i] > y[i];
        return false;
    }
    void MaybeCheckUpdate(long now)
    {
        if (updBusy) return;
        if ((fake && UpdTest == null) || !UpdatesOn()) { if (updAsked) { updAsked = false; Post(new Dictionary<string, object> { { "t", "updDone" }, { "ok", false }, { "why", fake ? "test" : "off" } }); } return; }
        if (updNext == 0) updNext = now;   // (a start, or checks just turned on: now)
        if (now < updNext) return;
        updBusy = true;
        System.Threading.ThreadPool.QueueUserWorkItem(delegate
        {
            string tag = null, url = null;
            bool answered = false;
            try
            {
                ServicePointManager.SecurityProtocol |= (SecurityProtocolType)3072;   // TLS 1.2
                var req = (HttpWebRequest)WebRequest.Create(UpdTest != null ? UpdTest + "/latest" : ReleasesApi);
                req.UserAgent = "HWDeck/" + AppInfo.Version; req.Accept = "application/vnd.github+json"; req.Timeout = 15000; req.ReadWriteTimeout = 15000;
                using (var resp = (HttpWebResponse)req.GetResponse())
                using (var rd = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
                {
                    answered = true;
                    var d = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(rd.ReadToEnd());
                    tag = d != null && d.ContainsKey("tag_name") ? d["tag_name"] as string : null;
                    url = d != null && d.ContainsKey("html_url") ? d["html_url"] as string : null;
                }
            }
            catch (WebException ex) { answered = ex.Response != null; if (!updLogged) Log("update check failed: " + ex.Message); updLogged = true; }
            catch (Exception ex) { if (!updLogged) Log("update check failed: " + ex.Message); updLogged = true; }
            Try(() => BeginInvoke((Action)(() =>
            {
                updBusy = false;
                bool asked = updAsked; updAsked = false;
                long t = Source.Unix();
                if (!answered) { updNext = t + (++updMissed <= 3 ? 120 : 3600); if (asked) Post(new Dictionary<string, object> { { "t", "updDone" }, { "ok", false }, { "why", "offline" } }); return; }   // offline
                updNext = t + (Ver(tag) != null ? 86400 : 3600); updLogged = false; updMissed = 0;   // (no version in the answer, GitHub's rate limit: in an hour)
                settings["updChecked"] = t;
                if (Ver(tag) != null)
                {
                    settings["updLatest"] = tag.TrimStart('v');
                    settings["updUrl"] = url != null && url.StartsWith(ReleasesPage, StringComparison.Ordinal) ? url : ReleasesPage + "latest";
                }
                SaveSettings();
                SendSettings();
                if (asked) Post(new Dictionary<string, object> { { "t", "updDone" }, { "ok", Ver(tag) != null }, { "latest", Ver(tag) != null ? tag.TrimStart('v') : null }, { "why", Ver(tag) != null ? "" : "answer" } });
            })));
        });
    }
    // ---- one-click update (an msi install only): the newest release's installer, checked against its SHA256SUMS.txt and
    // held open from then on, so nothing can change it, then msiexec started from here (it asks for permission, as for
    // Program Files). Once Windows said yes the installer closes HW Deck itself (util:CloseApplication in
    // installer\HWDeck.wxs) and, asked to (HWDECKRESTART), starts it again when it is done, without admin rights; a No, or an install that
    // couldn't start, comes back here (with msiexec's exit code when it ran). No script in between (11-09: Windows Defender took the old hidden PowerShell one for
    // malware). A zip copy, or anything else, gets the releases page instead ----
    bool updating;
    // the msi's install folder when this exe is the one installed there (HKLM\Software\<name>\InstallFolder), else null
    static string Installed()
    {
        try
        {
            using (var k = Microsoft.Win32.RegistryKey.OpenBaseKey(Microsoft.Win32.RegistryHive.LocalMachine, Microsoft.Win32.RegistryView.Registry64).OpenSubKey(@"Software\" + Brand.Name))
            {
                string f = k != null ? k.GetValue("InstallFolder") as string : null;
                return !string.IsNullOrEmpty(f) && string.Equals(Path.GetFullPath(Path.Combine(f, Path.GetFileName(Application.ExecutablePath))), Path.GetFullPath(Application.ExecutablePath), StringComparison.OrdinalIgnoreCase) ? f : null;
            }
        }
        catch { return null; }
    }
    void UpdateNow()
    {
        if (UpdTest != null) { Log("update now: refused in an update test copy"); var rt = Msg("toast"); rt["text"] = "Test copy: no update"; Post(rt); return; }   // (never a download, a browser or msiexec there)
        if (fake || Brand.NoActions || Installed() == null) { OpenRelease(); return; }
        if (updating) return;
        updating = true;
        var r = Msg("toast"); r["text"] = "Downloading the new HW Deck..."; Post(r);
        // (a thread of its own, in the background: the installer's start waits at the Windows prompt, and a HW Deck quit
        // meanwhile has to be able to end. From a pool thread .NET would start through the shell on a thread it makes
        // itself, one the process waits for)
        var worker = new System.Threading.Thread(delegate()
        {
            string msi = null, err = null, dir = null;
            FileStream held = null;
            try
            {
                ServicePointManager.SecurityProtocol |= (SecurityProtocolType)3072;   // TLS 1.2
                dir = Path.Combine(Path.GetTempPath(), "hwdeck-update-" + Guid.NewGuid().ToString("N"));
                Directory.CreateDirectory(dir);
                using (var wc = new WebClient())
                {
                    wc.Headers[HttpRequestHeader.UserAgent] = "HWDeck/" + AppInfo.Version;
                    string sums = wc.DownloadString(ReleasesPage + "latest/download/SHA256SUMS.txt");
                    var m = Regex.Match(sums, @"(?m)^([0-9a-fA-F]{64})\s+(HWDeck-([\d.]+)\.msi)\s*$");
                    if (!m.Success) throw new Exception("the latest release has no installer");
                    // ("latest" can change after the check that showed the button: never an older or the same version)
                    if (!Newer(m.Groups[3].Value, AppInfo.Version)) throw new Exception("the latest release (" + m.Groups[3].Value + ") isn't newer than this one");
                    msi = Path.Combine(dir, m.Groups[2].Value);
                    wc.DownloadFile(ReleasesPage + "latest/download/" + m.Groups[2].Value, msi);
                    // (held from here: read, never written, by anyone else. An antivirus looks at a new installer as it
                    // lands and may hold it a moment: tried again for 10 s)
                    for (int i = 0; held == null; i++)
                        try { held = new FileStream(msi, FileMode.Open, FileAccess.Read, FileShare.Read); }
                        catch (IOException) { if (i >= 19) throw; System.Threading.Thread.Sleep(500); }
                        catch (UnauthorizedAccessException) { if (i >= 19) throw; System.Threading.Thread.Sleep(500); }
                    string hash;
                    using (var sha = System.Security.Cryptography.SHA256.Create()) hash = BitConverter.ToString(sha.ComputeHash(held)).Replace("-", "");
                    if (!hash.Equals(m.Groups[1].Value, StringComparison.OrdinalIgnoreCase)) throw new Exception("the download doesn't match its published checksum");
                }
            }
            catch (Exception ex) { Log("update failed: " + ex.Message); err = ex is System.Net.WebException ? "no connection to GitHub, or the release isn't there" : ex is IOException || ex is UnauthorizedAccessException ? "a file it needs can't be written now" : ex.Message; }
            if (err != null)
            {
                if (held != null) held.Dispose(); if (dir != null) try { Directory.Delete(dir, true); } catch { }   // (a partial or wrong download goes too)
                Try(() => BeginInvoke((Action)(() => { updating = false; var t = Msg("toast"); t["text"] = "Couldn't update: " + err; Post(t); })));
                return;
            }
            // the installer, started from this thread (with a Windows prompt of its own, the start only comes back at the
            // answer: the window keeps running meanwhile). On an admin's account where HW Deck isn't running as admin (the
            // usual one), Windows Installer itself is started as admin: the one Windows prompt then names Windows Installer
            // and its publisher, Microsoft, with this installer's file under "Show more details". Started as the account,
            // the installer asks by itself, and that prompt names the file alone, from an unknown publisher (it isn't
            // signed). Any other account: as the account (its prompt asks for an admin's password; started as that admin,
            // the install would be that admin's). A No is Win32Exception 1223
            Process p = null; string bad = null; int code = -1;
            bool asAdmin = Elevated.LimitedAdmin();
            Elevated.SetUpdateFrom(AppInfo.Version);   // (for the copy the installer starts when it is done: see UpdateMarker)
            AllowSetForegroundWindow(-1);   // (the installer's window and the Windows prompt may take the front)
            for (int go = 0; ; go++)
            {
                p = null;
                try
                {
                    var si = new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "msiexec.exe"), "/i \"" + msi + "\" /passive /norestart HWDECKRESTART=1") { UseShellExecute = false };
                    if (asAdmin) { si.UseShellExecute = true; si.Verb = "runas"; }
                    p = Process.Start(si);
                }
                catch (Exception ex)
                {
                    var w = ex as System.ComponentModel.Win32Exception;
                    bool no = w != null && w.NativeErrorCode == 1223;
                    Log(no ? "update: No in the Windows prompt" : "update failed: " + ex.Message);
                    bad = no ? UpdateText(1602) : "Couldn't update: the installer didn't start";
                }
                if (p == null && bad == null) bad = "Couldn't update: the installer didn't start";
                if (bad != null)
                {
                    Elevated.SetUpdateFrom(null); held.Dispose(); try { Directory.Delete(dir, true); } catch { }
                    Try(() => BeginInvoke((Action)(() => { updating = false; var t = Msg("toast"); t["text"] = bad; Post(t); })));
                    return;
                }
                if (go == 0)
                {
                    Log("update: installing " + Path.GetFileName(msi) + (asAdmin ? " (Windows Installer started as admin)" : ""));
                    Try(() => BeginInvoke((Action)(() => { var u = Msg("toast"); u["text"] = "Installing the update: HW Deck closes and opens again"; Post(u); })));
                }
                // still here when msiexec is done: a No in the installer's own Windows prompt, or an install that didn't go
                // (once Windows said yes, the installer closes this copy first)
                code = -1;
                try { p.WaitForExit(); code = p.ExitCode; } catch { }
                // (as admin, Windows Installer runs in the account's other sign-in session, which has none of the drive
                // letters made in this one (subst, a network drive): a download folder on such a drive can't be opened
                // there, 1619 or 1620. Once more as the account, as before 2.4.5)
                if (asAdmin && (code == 1619 || code == 1620)) { Log("update: Windows Installer as admin couldn't open the download (" + code + "), started again as the account"); asAdmin = false; continue; }
                break;
            }
            Elevated.SetUpdateFrom(null);
            Try(() => BeginInvoke((Action)(() =>
            {
                updating = false; held.Dispose(); Try(() => Directory.Delete(dir, true));
                Log("update: the installer ended with " + code);
                var t = Msg("toast"); t["text"] = code == 0 ? "The update is in: quit " + Brand.Name + " from its tray icon and start it again" : UpdateText(code); Post(t);
            })));
        });
        worker.IsBackground = true; worker.SetApartmentState(System.Threading.ApartmentState.STA); worker.Start();
    }
    // a start after Update now: the installer starts HW Deck through the Windows shell, which passes no arguments, so the
    // copy that asked for the update left the version it had (HKCU UpdateFrom). This one is newer when the update went in.
    // Only the installed copy takes the note (never one next to it, on another data folder or from a zip), and a note
    // that can't be read (it is the account's own to write) is no note
    public static void UpdateMarker()
    {
        try
        {
            if (Installed() == null) return;
            string from = Elevated.TakeUpdateFrom();
            if (from == null || UpdateResult != int.MinValue) return;
            UpdateResult = Newer(AppInfo.Version, from) ? 0 : -3;
        }
        catch { }
    }
    // an update's leftovers (the installer closed HW Deck while it held the download): gone at the next start
    public static void UpdateLeftovers()
    {
        try
        {
            foreach (var d in Directory.GetDirectories(Path.GetTempPath(), "hwdeck-update-*"))
                try { if (DateTime.UtcNow - Directory.GetLastWriteTimeUtc(d) > TimeSpan.FromMinutes(5)) Directory.Delete(d, true); } catch { }
        }
        catch { }
    }
    // started again by the installer (or by an older HW Deck's update script) with msiexec's exit code: what the user is told once the window is up
    [DllImport("user32.dll")] static extern bool AllowSetForegroundWindow(int pid);
    public static int UpdateResult = int.MinValue;   // (none: an ordinary start)
    static string UpdateNote()
    {
        int c = UpdateResult;
        if (c == int.MinValue) return null;
        return c == 0 ? Brand.Name + " is updated to " + AppInfo.Version : c == 3010 || c == 1641 ? Brand.Name + " is updated to " + AppInfo.Version + ". Windows needs a restart to finish it" : UpdateText(c);
    }
    // an install that didn't go (or not all the way)
    static string UpdateText(int c)
    {
        return c == 1602 || c == 1625 ? "The update was cancelled, so this is still " + AppInfo.Version
             : c == 1618 ? "The update didn't install: another installation was running. Try Update now again in a minute"
             : c == -2 ? "The update didn't install: the downloaded installer changed before it could run"
             : c == -3 ? "The update didn't install, so this is still " + AppInfo.Version + ". Try Update now again, or get it from the releases page"
             : c == 3010 || c == 1641 ? "The update is in: Windows needs a restart to finish it"
             : "The update didn't install (installer code " + c + "). Try Update now again, or get it from the releases page";
    }
    void OpenRelease()
    {
        string u = settings.ContainsKey("updUrl") ? settings["updUrl"] as string : null;
        if (u == null || !u.StartsWith(ReleasesPage, StringComparison.Ordinal) || u.IndexOf('"') >= 0) u = ReleasesPage + "latest";
        Try(() => Process.Start(u));
    }

    // the logs: the page shows the last 12 MB (they keep the days set in Settings, see TrimAlerts); a clear keeps the old
    // log in a .bak next to it
    // a log for the page, read off the UI thread (it can be megabytes) and posted when it is in
    // (numbered per log: a read that comes in after a newer one, or after a Clear, is dropped)
    readonly Dictionary<string, int> logSeq = new Dictionary<string, int>();
    int NextLog(string type) { int n; logSeq.TryGetValue(type, out n); logSeq[type] = ++n; return n; }
    void SendLog(string file, string type)
    {
        int seq = NextLog(type);
        System.Threading.ThreadPool.QueueUserWorkItem(delegate
        {
            string text; try { text = Tail(file); } catch { text = ""; }
            Try(() => BeginInvoke((Action)(() => { if (logSeq[type] != seq) return; var r = Msg(type); r["log"] = text; Post(r); })));
        });
    }
    void SendCleared(string type) { NextLog(type); var r = Msg(type); r["log"] = ""; Post(r); }
    // the last game session for the page's Game cells while no game runs (2.1, "lastGame"): read again off the UI thread
    // when games.log changes (its length or time, looked at every second) and for a page that just loaded; a read that
    // failed (the file held) is tried again the next second
    long lgLen = -2; DateTime lgAt; int lgBusy;
    void CheckLastGame()
    {
        long len; DateTime at;
        try { var fi = new FileInfo(P("games.log")); len = fi.Exists ? fi.Length : -1; at = fi.Exists ? fi.LastWriteTimeUtc : DateTime.MinValue; } catch { return; }
        if (len == lgLen && at == lgAt) return;
        if (System.Threading.Interlocked.Exchange(ref lgBusy, 1) == 1) return;
        System.Threading.ThreadPool.QueueUserWorkItem(delegate
        {
            Dictionary<string, object> d = null; bool ok = true;
            try { d = len < 0 ? null : Games.LastOf(Tail("games.log"), Source.Unix()); } catch { ok = false; }
            if (!ok || !Try(() => BeginInvoke((Action)(() => { lgLen = len; lgAt = at; lgBusy = 0; var r = Msg("lastGame"); r["s"] = d; Post(r); })))) lgBusy = 0;
        });
    }
    // HWiNFO's readings it has only ever seen at 0 since it started (an empty fan header, a voltage input with nothing
    // on it): Storage hides them unless asked. Left out: Yes/No readings (No all along is news too), error counts (0 is
    // the good news) and a GPU's fans (stopped at idle on purpose)
    string zeroSent = "";
    static readonly Regex ZeroKeep = new Regex(@"\berrors?\b", RegexOptions.IgnoreCase), GpuSensor = new Regex(@"^[di]?GPU\b");   // (dGPU [#0]: ..., GPU [#0]: ...)
    List<object> ZeroKeys()
    {
        var z = new List<object>();
        var hw = src.Inner;
        int n = Math.Min(hw.Readings.Count, Math.Min(src.Min.Length, src.Max.Length));
        for (int i = 0; i < n; i++)
        {
            var r = hw.Readings[i];
            if (src.Min[i] != 0 || src.Max[i] != 0 || r.Unit == "Yes/No" || ZeroKeep.IsMatch(r.Label ?? "")) continue;
            if ((r.Unit == "RPM" || (r.Label ?? "").IndexOf("Fan", StringComparison.OrdinalIgnoreCase) >= 0) && r.Sensor >= 0 && r.Sensor < hw.Sensors.Count && GpuSensor.IsMatch(hw.Sensors[r.Sensor].Name ?? "")) continue;   // (its speed or its duty %)
            z.Add(r.Key);
        }
        return z;
    }
    string Tail(string name)
    {
        string p = P(name);
        if (!File.Exists(p)) return "";
        using (var fs = new FileStream(p, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))   // (a trim or an edit can replace it meanwhile)
        {
            long take = Math.Min(fs.Length, 12 << 20);
            fs.Seek(-take, SeekOrigin.End);
            using (var sr = new StreamReader(fs, Encoding.UTF8))
            {
                string s = sr.ReadToEnd();
                if (take < fs.Length) { int nl = s.IndexOf('\n'); if (nl >= 0) s = s.Substring(nl + 1); }
                return s;
            }
        }
    }
    void Wipe(string name)
    {
        string p = P(name);
        if (!File.Exists(p)) return;
        long had = new FileInfo(p).Length;
        File.AppendAllText(p + ".bak", File.ReadAllText(p));
        File.WriteAllText(p, "");
        ShortenBin(p + ".bak", had);
    }
    // how many some lines hold: sessions, or warnings as crossings, read as the page's list reads them (one opens at a
    // yellow or red of a cell with none open; its end, or a mark, closes it), not lines: a crossing that went red is one
    static readonly Regex LvlRe = new Regex(@"^\S+ \S+\s+(YELLOW|RED|OK|MARK|PEAK)\s+(.+)$");
    static int Count(string name, IEnumerable<string> ls)
    {
        if (name == "games.log") return ls.Count(l => l.StartsWith("{"));
        int n = 0; var open = new HashSet<string>();
        foreach (var l in ls)
        {
            var m = LvlRe.Match(l); if (!m.Success) continue;
            string lv = m.Groups[1].Value, rest = m.Groups[2].Value;
            if (lv == "MARK") { open.Clear(); continue; }
            if (lv == "OK") { int b = rest.IndexOf(": back to normal", StringComparison.Ordinal); open.Remove(b > 0 ? rest.Substring(0, b) : rest); continue; }
            if (lv == "PEAK") continue;   // (a peak so far: no crossing of its own)
            int c = rest.LastIndexOf(": ", StringComparison.Ordinal); string nm = c > 0 ? rest.Substring(0, c) : rest;
            if (open.Add(nm)) n++;   // (a yellow or red of one already open is part of it: 1.0.x logged a step down from red as a yellow)
        }
        return n;
    }
    // a bin keeps what it was just given, and up to 32 MB of what came before (cut back to that once it is past 48 MB:
    // at its cap it was read and written whole at every trim, 11-06)
    internal static long Bytes(IEnumerable<string> ls) { return ls.Sum(l => (long)Encoding.UTF8.GetByteCount(l) + 2); }
    internal static void ShortenBin(string p, long added) { try { var fi = new FileInfo(p); if (fi.Exists && fi.Length > added + (48L << 20)) Shorten(p, added + (32L << 20)); } catch { } }
    static readonly Regex LineAt = new Regex(@"^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)([+-]\d\d:\d\d)?"), StartAt = new Regex("\"start\":(\\d+)");
    static long LineTime(string l)
    {
        var m = StartAt.Match(l); if (m.Success) { long v; if (long.TryParse(m.Groups[1].Value, out v)) return v; }   // (a session: its start)
        var t = LineAt.Match(l);
        if (t.Success) { DateTimeOffset d; if (DateTimeOffset.TryParse(t.Groups[1].Value + (t.Groups[2].Success ? t.Groups[2].Value : ""), System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.AssumeLocal, out d)) return d.ToUnixTimeSeconds(); }
        return 0;
    }
    // a line the days you keep would set aside again at once: a session that ended before the cut, a warning on a day
    // before it (null: kept forever, or no days set)
    Func<string, bool> OlderThanKept(string which)
    {
        string k = which == "games" ? "gameDays" : "warnDays";
        if (!DaysSet(k) || KeepDays(k) == 0) return null;
        if (which == "games") { long cut = Source.Unix() - KeepDays(k) * 86400L; return l => { var m = EndRe.Match(l); long e; return m.Success && long.TryParse(m.Groups[1].Value, out e) && e < cut; }; }
        string c = DateTime.Now.AddDays(-(KeepDays(k) + 1)).ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture);
        return l => l.Length >= 10 && char.IsDigit(l[0]) && string.CompareOrdinal(l.Substring(0, 10), c) < 0;
    }
    // lines moved, exactly as they are, from a log to its bin (bin first, once: a failed swap leaves a copy twice, never
    // none, and a move tried again doesn't add it twice) or from its bin back into it, put in among the log's lines by
    // time, once each; written flushed (a power cut leaves the old file or the new one). How many: sessions, or crossings
    int MoveLines(string name, List<string> lines, bool toLog, out List<string> moved)
    {
        lock (name == "games.log" ? games.LogLock : alertsLock)
        {
            string p = P(name), b = p + ".bak", src = toLog ? b : p;
            var want = new HashSet<string>(lines);
            var from = File.Exists(src) ? File.ReadAllLines(src, Encoding.UTF8) : new string[0];
            moved = from.Where(l => want.Contains(l)).ToList();
            if (moved.Count == 0) return 0;
            var keep = from.Where(l => !want.Contains(l) && l.Trim().Length > 0).ToList();
            if (toLog)
            {
                var cur = File.Exists(p) ? File.ReadAllLines(p, Encoding.UTF8).Where(l => l.Trim().Length > 0).ToList() : new List<string>();
                Disk.SwapLines(p, Merge(cur, moved));
                if (keep.Count > 0) Disk.SwapLines(b, keep); else File.Delete(b);
            }
            else
            {
                var had = File.Exists(b) ? new HashSet<string>(File.ReadAllLines(b, Encoding.UTF8)) : new HashSet<string>();
                var add = moved.Where(l => !had.Contains(l)).ToList();
                if (add.Count > 0) { Disk.AppendLines(b, add); ShortenBin(b, Bytes(add)); }
                Disk.SwapLines(p, keep);
            }
            return Count(name, moved);
        }
    }
    // lines deleted permanently from a log's bin, exactly as they are, every copy (written flushed, like a move); how many:
    // sessions, or crossings
    int PurgeLines(string name, List<string> lines, out List<string> gone)
    {
        lock (name == "games.log" ? games.LogLock : alertsLock)
        {
            string b = P(name) + ".bak";
            var want = new HashSet<string>(lines);
            var from = File.Exists(b) ? File.ReadAllLines(b, Encoding.UTF8) : new string[0];
            gone = from.Where(l => want.Contains(l)).Distinct().ToList();
            if (gone.Count == 0) return 0;
            var keep = from.Where(l => !want.Contains(l) && l.Trim().Length > 0).ToList();
            if (keep.Count > 0) Disk.SwapLines(b, keep); else File.Delete(b);
            return Count(name, gone);
        }
    }
    readonly object alertsLock = new object();   // (alerts.log is written on this thread: the lock only matches games.log's)
    // settings "paceLog" (2.0.1, no switch in the page, off unless set in settings.json): while a game's frames are counted,
    // a line a second of the bottleneck's inputs, its call and the game's pace in numbers (Frames.PaceText), in pace.log
    // (its newest 20 MB), to tune Frames.Pace from real games
    int paceLines;
    void PaceLog()
    {
        var fr = src.Frames; if (fr == null) return;
        fr.LogPace = settings.ContainsKey("paceLog") && true.Equals(settings["paceLog"]);
        if (!fr.LogPace || fr.PaceLine == null) return;
        var b = src.Bneck; var inv = System.Globalization.CultureInfo.InvariantCulture;
        PaceAppend(DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss", inv) + "  gpu " + b.Gpu.ToString("0", inv) + " cpu " + b.Cpu.ToString("0", inv) +
            " call " + b.Live + " pace " + (fr.Steady == null ? "-" : fr.Steady.Value ? "held" : "not") + "  " + fr.PaceLine);
    }
    // (2.1, the perf review 11-04: one stream kept open while lines come, closed 10 s after the last; past 20 MB it becomes
    // pace.log.old and a new one starts. Before: opened and closed every second, and cut to 20 MB by a rewrite hourly)
    FileStream paceFs; long paceAt;
    void PaceAppend(string line)
    {
        try
        {
            if (paceFs == null)
            {
                string p = P("pace.log");
                if (File.Exists(p) && new FileInfo(p).Length > (20L << 20)) { string o = p + ".old"; try { File.Delete(o); } catch { } File.Move(p, o); }
                paceFs = new FileStream(p, FileMode.Append, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete);
            }
            var b = Encoding.UTF8.GetBytes(line + "\r\n"); paceFs.Write(b, 0, b.Length); paceFs.Flush();
            paceAt = Source.Unix();
            if (paceFs.Length > (20L << 20)) ClosePace();   // (the next line moves it aside)
        }
        catch { ClosePace(); }
    }
    void ClosePace() { var f = paceFs; paceFs = null; if (f != null) try { f.Dispose(); } catch { } }
    // lines put in among a log's own by time, the log's order kept as it is (one written across a clock change stays as it
    // was); at the same second, a mark that ends something (an exit, a sleep, HWiNFO stopping) goes after them, so a
    // crossing's peak comes back before the mark that ended it; an app's start stays before them
    static List<string> Merge(List<string> cur, List<string> moved)
    {
        Func<string, bool> ends = l => l.Contains("  MARK  ") && !l.Contains("MARK    app start");
        var add = moved.Where(l => l.Trim().Length > 0).Select((l, i) => new { l, i, t = LineTime(l) }).OrderBy(x => x.t).ThenBy(x => x.i).ToList();
        var have = new HashSet<string>(cur); var outp = new List<string>(cur.Count + add.Count); int k = 0;
        foreach (var c in cur)
        {
            long tc = LineTime(c); bool e = ends(c);
            while (k < add.Count && (add[k].t < tc || (add[k].t == tc && e))) { if (have.Add(add[k].l)) outp.Add(add[k].l); k++; }
            outp.Add(c);
        }
        for (; k < add.Count; k++) if (have.Add(add[k].l)) outp.Add(add[k].l);
        return outp;
    }
    // keep the end of a file that only grows
    internal static void Shorten(string p, long max)
    {
        try
        {
            var fi = new FileInfo(p);
            if (!fi.Exists || fi.Length <= max) return;
            string s; using (var fs = new FileStream(p, FileMode.Open, FileAccess.Read)) { fs.Seek(-max, SeekOrigin.End); s = new StreamReader(fs, Encoding.UTF8).ReadToEnd(); }
            int nl = s.IndexOf('\n'); Disk.Swap(p, nl >= 0 ? s.Substring(nl + 1) : s);
        }
        catch { }
    }
    // how long the logs keep what they have: forever unless Settings says otherwise (1 to 3650 days; 0: forever)
    static int Days(object o) { long d = Games.Long(o); return d == long.MinValue ? 30 : (int)Math.Max(0, Math.Min(3650, d)); }
    // the same game started again within this many minutes goes on with its session (Settings: Same game again; 0: never)
    int MergeMins() { object o; long v = settings.TryGetValue("gameMerge", out o) && o != null ? Games.Long(o) : long.MinValue; return v == long.MinValue ? 30 : (int)Math.Max(0, Math.Min(240, v)); }
    // forever (0 from the page) is kept as a flag next to 3650 days: a version from before it reads 3650, where 0 would
    // be 1 day and cut nearly everything
    int KeepDays(string k) { object f; if (settings.TryGetValue(k.Replace("Days", "Forever"), out f) && f is bool && (bool)f) return 0; return settings.ContainsKey(k) ? Days(settings[k]) : 0; }
    void SetKeep(string log, object v)
    {
        int d = Days(v);
        settings[log + "Days"] = d == 0 ? 3650 : d;
        if (d == 0) settings[log + "Forever"] = true; else settings.Remove(log + "Forever");
    }
    static int Rename(Dictionary<string, object> o, string name) { o["game"] = name; return 2; }
    // the game log: sessions that ended more than the days you keep ago go (into games.log.bak)
    static readonly Regex EndRe = new Regex("\"end\":(\\d+)");
    void TrimGames()
    {
        if (!DaysSet("gameDays") || KeepDays("gameDays") == 0) return;   // (0: kept forever)
        long cut = Source.Unix() - KeepDays("gameDays") * 86400L;
        // (a look first, 11-06: no session that ended before the cut, nothing more to do; the lines aren't in order, so
        // each is looked at)
        try
        {
            bool any = false;
            lock (games.LogLock)
                if (File.Exists(games.LogPath))
                    foreach (var l in File.ReadLines(games.LogPath)) { var m = EndRe.Match(l); long e; if (m.Success && long.TryParse(m.Groups[1].Value, out e) && e < cut) { any = true; break; } }
            if (!any) return;
        }
        catch { }   // (it can't be read now: the trim below says why)
        // (only lines that end before the cut get parsed: the rest stay as they are, and nothing is written when none goes)
        try { games.EditLog(o => { object e; return o.TryGetValue("end", out e) && Games.Long(e) < cut ? 1 : 0; }, line => { var m = EndRe.Match(line); long e; return !m.Success || !long.TryParse(m.Groups[1].Value, out e) || e < cut; }); }
        catch (Exception ex) { Log("trimming games.log failed: " + ex.Message); }
    }
    // the warning log keeps the days you keep (and one more, for time zones): a cell that flaps on its line can
    // write thousands of lines a day
    void TrimAlerts()
    {
        try
        {
            if (!DaysSet("warnDays") || KeepDays("warnDays") == 0) return;   // (0: kept forever)
            string p = P("alerts.log");
            if (!File.Exists(p)) return;
            string cut = DateTime.Now.AddDays(-(KeepDays("warnDays") + 1)).ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture);
            Func<string, bool> old = l => l.Length < 10 || string.CompareOrdinal(l.Substring(0, 10), cut) < 0;
            // (read up to the first line kept: most days nothing goes, and the log isn't read whole for that)
            using (var e = File.ReadLines(p).GetEnumerator()) if (!e.MoveNext() || !old(e.Current)) return;
            var lines = File.ReadAllLines(p);
            int i = 0; while (i < lines.Length && old(lines[i])) i++;
            if (i > 0)   // (what goes is kept in alerts.log.bak first, like a Clear; then the rest is written whole through a temp file)
            {
                Disk.AppendLines(p + ".bak", lines.Take(i)); ShortenBin(p + ".bak", Bytes(lines.Take(i)));
                Disk.SwapLines(p, lines.Skip(i));
            }
        }
        catch (Exception ex) { Log("trimming alerts.log failed: " + ex.Message); }
    }
    void AppendLog(string name, string line) { try { Disk.Append(P(name), line + "\r\n"); } catch { } }
    void WriteAlerts()
    {
        if (alerts.Lines.Count == 0) return;
        try { Disk.AppendLines(P("alerts.log"), alerts.Lines); alerts.Lines.Clear(); }   // cleared only once written (a half write is cut back off)
        catch { if (alerts.Lines.Count > 1000) alerts.Lines.RemoveRange(0, alerts.Lines.Count - 1000); }
    }
    void RefreshRules()
    {
        alerts.SetLayout(layout, src);
        // the readings of gated cells: the game report follows them too, with their lines
        var set = new Dictionary<string, Games.Lines>();
        var L = layout as Dictionary<string, object>;
        object cellsObj = null;
        var cells = L != null && L.TryGetValue("cells", out cellsObj) ? cellsObj as Dictionary<string, object> : null;
        if (cells != null)
            foreach (var c in cells.Values.OfType<Dictionary<string, object>>())
            {
                object g, key, mode = null, y, r, dir, name;
                var gd = c.TryGetValue("gates", out g) ? g as Dictionary<string, object> : null;
                if (gd != null) gd.TryGetValue("mode", out mode);
                if (!c.TryGetValue("key", out key) || !(key is string) || (string)key == Bottleneck.Key || !("y".Equals(mode) || "yr".Equals(mode)) || set.ContainsKey((string)key)) continue;
                set[(string)key] = new Games.Lines { Y = gd.TryGetValue("y", out y) ? Alerts.Num(y, double.NaN) : double.NaN, R = "yr".Equals(mode) && gd.TryGetValue("r", out r) ? Alerts.Num(r, double.NaN) : double.NaN,
                                                     Below = gd.TryGetValue("dir", out dir) && "below".Equals(dir), Name = c.TryGetValue("name", out name) ? name as string : null };
            }
        gated = set;
        // the readings the report setup (L.games) asks for, by key
        var tracked = new HashSet<string>();
        object gm;
        var gdict = L != null && L.TryGetValue("games", out gm) ? gm as Dictionary<string, object> : null;
        object secsObj = null;
        var secs = gdict != null && gdict.TryGetValue("secs", out secsObj) ? secsObj as System.Collections.IEnumerable : null;
        if (secs != null)
            foreach (var sec in secs.OfType<Dictionary<string, object>>())
            {
                object cellsList;
                if (!sec.TryGetValue("cells", out cellsList) || !(cellsList is System.Collections.IEnumerable)) continue;
                foreach (var c in ((System.Collections.IEnumerable)cellsList).OfType<Dictionary<string, object>>())
                {
                    object k;
                    if (c.TryGetValue("key", out k) && k is string && ((string)k).Length > 0 && ((string)k).Length <= 200 && (string)k != Bottleneck.Key && tracked.Count < 200) tracked.Add((string)k);
                }
            }
        games.Tracked = tracked;
    }

    void Subscribe(Dictionary<string, object> m)
    {
        var cells = new HashSet<string>(((System.Collections.ArrayList)m["cells"]).Cast<object>().Select(x => x as string).Where(x => x != null));
        var rows = new HashSet<string>(((System.Collections.ArrayList)m["rows"]).Cast<object>().Select(x => x as string).Where(x => x != null));
        var fresh = cells.Where(k => !subCells.Contains(k)).ToList();
        subCells = cells; subRows = rows;
        if (fresh.Count > 0) { SendSparks(fresh); force = true; }
    }
    long hiddenAt;   // the second the window last stopped showing
    void SendSparks(IEnumerable<string> keys, int last = History.SecLen)
    {
        long now = Source.Unix();
        var d = new Dictionary<string, object>();
        foreach (var k in keys) { var s = hist.Seconds(k, now); d[k] = last >= s.Length ? s : s.Skip(s.Length - last).ToArray(); }   // (the newest `last`, ending now)
        var r = Msg("spark"); r["ts"] = now; r["keys"] = d;
        Post(r);
    }

    static object Num(double v) { return double.IsNaN(v) || double.IsInfinity(v) || v == double.MaxValue || v == double.MinValue ? null : (object)Math.Round(v, 3); }

    readonly Dictionary<string, long> logged = new Dictionary<string, long>();
    bool lastPm;
    bool gameFront;   // the session's game is the window in front this second
    DateTime trimDay = DateTime.Now.Date;
    void OnTick(object s, EventArgs e)
    {
        UiTrace.TimerFired(); long ta = UiTrace.Now();
        // whatever goes wrong in one tick goes to app.log (once a minute per kind), never to a dialog every 250 ms
        try { Tick(); UiTrace.Took("tick", ta); }
        catch (Exception ex)
        {
            string k = ex.GetType().Name + ex.TargetSite; long at, now = Source.Unix();
            if (!logged.TryGetValue(k, out at) || now - at >= 60) { logged[k] = now; Log("tick failed: " + ex); }
        }
    }
    IntPtr otherFront;   // NoFocus: the last window in front that wasn't this one
    void Tick()
    {
        if (NoFocus) { var f = GetForegroundWindow(); if (f != IntPtr.Zero && f != Handle) otherFront = f; }
        long now = Source.Unix();
        if (now != lastSecond || force || indexVersion < 0) src.Poll();   // (the other ticks only watch the window)
        if (indexVersion != src.Version)
        {
            indexVersion = src.Version; index.Clear();
            for (int i = 0; i < src.Readings.Count; i++) index[src.Readings[i].Key] = i;
            if (layout != null) RefreshRules();
        }
        bool second = now != lastSecond;
        if (second) MaybeCheckUpdate(now);
        bool pmOk = false;
        if (second)
        {
            lastSecond = now;
            // a game seen running by the last poll, not one in its 30 s grace after closing (plain reads of fields the game poll sets)
            // (the poll looks every 3 s; an alt-tab counts at once, so a game's background fps cap is never its numbers)
            gameFront = games.InFront && (games.GamePid == 0 || Procs.Foreground() == games.GamePid);
            if (src.Frames != null) src.Frames.Pid = gameFront ? games.GamePid : 0;   // (out of front: no numbers, no 0 fps warnings)
            if (MaybeGpuRestart()) return;   // (this copy is closing)
            Try(WinBack);
            string gx = games.GameExe;   // (HWiNFO's PresentMon on the game in front: its fps are the game's, see pmOk below)
            src.Second(games.Game != null && now - games.Seen <= 6, games.Game != null && gameFront && (src.PmProc == null || gx == null || string.Equals(src.PmProc, gx, StringComparison.OrdinalIgnoreCase)), gameFront);
            PaceLog();
            if (paceFs != null && Source.Unix() - paceAt > 10) ClosePace();   // (no line for 10 s: the game is gone)
            hist.Sample(src, Bottleneck.ShareKeys, src.Bneck.Shares);
            Batt.Feed(src.Inner, games.Game != null && now - games.Seen <= 6);   // (the headset page's temperatures; a game keeps it lit)
            try { HsPage.Feed(src); } catch (Exception ex) { if (!hsFeedSaid) { hsFeedSaid = true; Log("headset page: its readings failed: " + ex.Message); } }
            ExtSecond(now);
            if (pageReady && now % 10 == 0 && src.Inner.Readings.Count > 0)
            {
                var z = ZeroKeys(); string zk = string.Join("|", z);
                if (zk != zeroSent) { zeroSent = zk; var zm = Msg("zero"); zm["keys"] = z; Post(zm); }
            }
            // HWiNFO's PresentMon follows whatever presents frames (the desktop, a browser, this app): its fps only
            // mean something while the game is in front and PresentMon follows the game's own process
            if (pmVersion != src.Version)
            {
                pmVersion = src.Version; pmKeys = new HashSet<string>();
                foreach (var r in src.Readings) if (r.Sensor >= 0 && r.Sensor < src.Sensors.Count && src.Sensors[r.Sensor].Name.StartsWith("PresentMon")) pmKeys.Add(r.Key);
            }
            string gexe = games.GameExe;
            pmOk = games.Game != null && gameFront && (src.PmProc == null || gexe == null || string.Equals(src.PmProc, gexe, StringComparison.OrdinalIgnoreCase));
            alerts.Skip = pmOk ? new HashSet<string>() : pmKeys; alerts.SkipHold = games.Game != null;
            // HWiNFO not sharing for 10 s (the free version stops every 12 h): say so in the log and the tray, end open episodes
            if (src.Status != "ok")
            {
                if (notOkSince == 0) notOkSince = now;
                if (!paused && now - notOkSince >= 10)
                {
                    paused = true; alerts.Mark("HWiNFO stopped sharing, warnings paused");
                    tray.Text = Brand.Name + ": HWiNFO isn't sharing, warnings paused";
                }
            }
            else
            {
                notOkSince = 0;
                if (paused) { paused = false; alerts.Lines.Add(AppInfo.Stamp() + "  INFO    HWiNFO back, warnings on"); tray.Text = Brand.Name; }   // not a MARK: it ends nothing
            }
            // no verdicts from the sleep mark to the wake (or a minute on, if Windows never said it woke)
            if (asleep && Environment.TickCount - sleptAt > 60000) asleep = false;
            if (!asleep) alerts.Tick(src, index);
            WriteAlerts();
            games.Sample(src, index, gated, alerts, gameFront, pmOk, pmKeys, src.Bneck.Call, src.Bneck.Live);
            // (the sessions popup open: the session in progress every 5 s, Now playing; the log again once a line came or went)
            // (only while shown, 11-06: the window away, a change waits for the show, which sends both)
            if (gamesLive && pageReady && wasShowing) { if (games.LogChanged) { games.LogChanged = false; PostLive(); SendLog("games.log", "games"); } else if (now % 5 == 0) PostLive(); }   // (the live one first: the log that comes after has it)
            else if (!gamesLive) games.LogChanged = false;
            if (DateTime.Now.Date != trimDay) { trimDay = DateTime.Now.Date; TrimAlerts(); TrimGames(); }   // the days you keep, also on a PC that never restarts
            if (!fake && now - lastHwPath >= 60) { lastHwPath = now; RememberHwinfo(); }
            // (a view save another program's handle refused: the page sends its view again, with its gen; a settings save the
            // same: written again)
            if (stateRetryAt > 0 && pageReady && (Source.Unix() >= stateRetryAt || stateRetryAt - Source.Unix() > 5)) { stateRetryAt = 0; Post(Msg("saveView")); }   // (or the clock set back)
            if (settingsRetry && now % 5 == 0) SaveSettings();
            if (HsPage.SaveFailed && now % 5 == 3) HsPage.Retry();   // (the headset page, 11-17)
            if ((settingsRetry || HsPage.SaveFailed) && !saveToastSaid && pageReady) { saveToastSaid = true; var st = Msg("toast"); st["text"] = settingsRetry ? "Couldn't save your settings: trying again" : "Couldn't save the headset page: trying again"; Post(st); }   // (one for the run, as the layout's, 11-17)
            if (settingsHeld && now % 5 == 2) RetrySettings();
            // (free now: the page gets it; the view first, whole; slots alone, so the view and its undo stay as they are)
            if (heldFiles.Count > 0 && pageReady && now % 5 == 0)
            {
                long un = Source.Unix();
                var stale = heldFiles.Where(n => { long t; return heldAt.TryGetValue(n, out t) && un - t >= 120; }).ToList().Where(GiveUp).ToList();
                // (a damaged view: the page keeps what it shows, built meanwhile or the empty first run, and writes it now)
                if (stale.Contains("state")) Post(Msg("saveView"));
                if (stale.Any(n => n != "state")) SendSlots();   // (the damaged slots, empty, even while the view stays held)
                if (heldFiles.Contains("state")) { if (CanOpen(P("state.json"))) SendState(true); else if (heldFiles.Any(n => n != "state" && CanOpen(P(n + ".json")))) SendSlots(); }   // (slots freed while the view stays held go alone)
                else if (heldFiles.Any(n => CanOpen(P(n + ".json")))) SendSlots();
                // (the notes of what was given up: one toast, after anything above that could post its own)
                if (goneNotes.Count > 0 && wasShowing) { var tb = Msg("toast"); tb["text"] = string.Join(" ", goneNotes); tb["ms"] = goneNotes.Count > 1 ? 20000 : 15000; Post(tb); goneNotes.Clear(); }
            }
        }
        // (2.1: every 15 min what closed since goes on the end of hist.jrn; hist.bin is written whole once a day, after a
        // start that found a journal, and at exit. The clock set back: saved now, counted from there)
        if (now - lastSave >= 900 || now < lastSave)
        {
            lastSave = now;
            if (hist.HadJournal || now - lastFull >= 86400 || now < lastFull) { lastFull = now; hist.Save(false); } else hist.Journal();
        }
        bool showing = pageReady && Visible && !IsIconic(Handle);   // (Windows' own word: a restore that skips the focus doesn't always update WindowState)
        if (showing && !wasShowing)
        {
            force = true; SendSparks(subCells, hiddenAt > 0 ? (int)Math.Min(History.SecLen, now - hiddenAt + 3) : History.SecLen);   // back from the tray or the taskbar: the page missed those seconds (2.1: only those)
            Post(Msg("shown"));                  // and measures its tiles again on screen (hidden, some came out short)
            if (gamesLive) { PostLive(); if (games.LogChanged) { games.LogChanged = false; SendLog("games.log", "games"); } }   // (the sessions popup open: what it missed)
            // (one toast: the page has one, so each would replace the one before)
            var notes = new List<string>();
            if (stateBad != null) { notes.Add("Your view couldn't be read, so it starts empty. The old file is kept as " + stateBad + " in your files (Settings)."); stateBad = null; }
            if (UpdateNote() != null) { notes.Add(UpdateNote()); Log("update result: " + UpdateResult); UpdateResult = int.MinValue; }
            if (heldFiles.Contains("state")) notes.Add(HeldNote);
            notes.AddRange(goneNotes); goneNotes.Clear();
            if (notes.Count > 0) { var tn = Msg("toast"); tn["text"] = string.Join(" ", notes.Select(n => n.TrimEnd().EndsWith(".") ? n.TrimEnd() : n.TrimEnd() + ".")); tn["ms"] = notes.Count > 1 ? 20000 : 15000; Post(tn); }
        }
        if (wasShowing && !showing) hiddenAt = now;
        wasShowing = showing;
        bool feedHidden = false;
        if (pageReady && !showing) ExtFeedHidden(ref feedHidden);   // (a build whose page draws something else from the seconds, the dashboard's small screen)
        if (!(showing || feedHidden) || !(second || force)) return;
        force = false;
        if (src.Version != sentVersion)
        {
            sentVersion = src.Version;
            var r = Msg("catalog");
            r["ver"] = src.Version;
            r["sensors"] = src.Sensors.Select(x => (object)new object[] { x.Key, x.Name }).ToList();
            r["readings"] = src.Readings.Select(x => (object)new object[] { x.Sensor, x.Type, x.Key, x.Label, x.Unit, x.Kind }).ToList();
            r["bneck"] = src.Bneck.Inputs;
            r["c12"] = src.Conn.Has ? src.Conn.Keys : null;
            r["zero"] = ZeroKeys(); zeroSent = string.Join("|", (List<object>)r["zero"]);
            Post(r);
        }
        var want = new HashSet<string>(subCells); want.UnionWith(subRows);
        var ix = new List<object>(); var vs = new List<object>(); var mn = new List<object>(); var mx = new List<object>(); var av = new List<object>();
        foreach (var k in want)
        {
            int i;
            if (!index.TryGetValue(k, out i) || i >= src.Values.Length) continue;
            ix.Add(i); vs.Add(Num(src.Values[i]));
            bool cell = subCells.Contains(k);
            mn.Add(cell ? Num(src.Min[i]) : null); mx.Add(cell ? Num(src.Max[i]) : null); av.Add(cell ? Num(src.Avg[i]) : null);
        }
        var tk = Msg("tick");
        tk["ver"] = src.Version; tk["status"] = src.Status; tk["age"] = src.Age; tk["ts"] = now;
        tk["gameGap"] = games.GapSecs;   // (the session's breaks: not play)
        tk["i"] = ix; tk["v"] = vs; tk["mn"] = mn; tk["mx"] = mx; tk["av"] = av;
        tk["game"] = games.Game; tk["front"] = gameFront; tk["gameSince"] = games.Since;   // plain reads of fields the game poll sets
        tk["pm"] = pmOk || !second && lastPm; lastPm = (bool)tk["pm"];
        char bl = src.Bneck.Live; tk["bnl"] = bl == 'g' ? (object)1 : bl == 'c' ? (object)2 : bl == 'f' ? (object)3 : null;   // the call with no game too
        tk["net"] = Net.State();
        if (Batt.HeadSeen) tk["hs"] = Batt.Card();   // (the Headset cell and its popup, 11-13)   // (the internet cell's popup and Settings: the speed test, 2.4.8)
        tk["bnb"] = src.BlindNote;   // (a game in front whose frames aren't counted: 1 only vsync caps can be seen, 2 none)
        if (src.Conn.Has) tk["c12"] = new object[] { src.Conn.Lopsided, src.Conn.Hot, Math.Round(src.Conn.Share, 1) };
        var gs = games.SessionPm(); if (gs != null) tk["gs"] = gs;
        var sf = games.SessionFps(); if (sf != null) tk["sf"] = sf;   // (this session's average fps and 1% low)
        tk["rec"] = games.Running();   // your own sessions running: [start, name]
        Post(tk);
        CheckLastGame();   // (after the tick: the page has it by the next)
    }

    // ---- HWiNFO: remember where it runs from, so a restart (free HWiNFO turns shared memory off after 12 h) can start it again ----
    int hwinfoPid;   // (the HWiNFO the last look found: while it runs, it alone is checked; 2.1, the perf audit 11-04)
    static bool IsHwinfo(string path) { string f = Path.GetFileName(path ?? ""); return f.Equals("HWiNFO64.exe", StringComparison.OrdinalIgnoreCase) || f.Equals("HWiNFO32.exe", StringComparison.OrdinalIgnoreCase); }
    void RememberHwinfo()
    {
        try
        {
            var devices = Procs.Devices();
            string path = hwinfoPid > 0 ? Procs.ImagePath(hwinfoPid, devices) : null;
            if (!IsHwinfo(path))
            {
                hwinfoPid = 0; path = null;
                foreach (int pid in Procs.Pids()) { string p = Procs.ImagePath(pid, devices); if (IsHwinfo(p)) { hwinfoPid = pid; path = p; break; } }
            }
            if (path == null || (settings.ContainsKey("hwinfo") && path.Equals(settings["hwinfo"] as string, StringComparison.OrdinalIgnoreCase))) return;
            settings["hwinfo"] = path; SaveSettings(); SendSettings();
        }
        catch { }
    }
    // Restart HWiNFO (Settings, the setup screen, the stale banner): this copy's HWiNFO task does it with no Windows prompt
    // (the installer made it, see Elevated); without one, or for an HWiNFO outside its installer's folder, this exe as admin
    // through one Windows prompt. What a restart does: Elevated.Restart
    void RestartHwinfo()
    {
        var r = Msg("toast");
        if (fake) { r["text"] = "Demo data: there is no HWiNFO to restart"; Post(r); Restarted(-3); return; }
        if (Brand.NoActions) { r["text"] = "Test copy: HWiNFO isn't restarted"; Post(r); Restarted(-3); return; }
        if (restarting) { r["text"] = "HWiNFO is restarting already"; Post(r); return; }   // (the page's button keeps turning)
        string exe = settings.ContainsKey("hwinfo") ? settings["hwinfo"] as string : null;
        if (exe != null && (!Regex.IsMatch(Path.GetFileName(exe), @"^HWiNFO(64|32)\.exe$", RegexOptions.IgnoreCase) || !File.Exists(exe))) exe = null;
        // (none where a restart looks either: said now, without a Windows prompt for nothing, 11-06)
        if (exe == null && Elevated.FindHwinfo() == null)
        { Log("hwinfo restart: not found"); r["text"] = "HWiNFO wasn't found: start it once yourself, " + Brand.Name + " remembers where it is"; Post(r); Restarted(3); return; }
        restarting = true;
        Log("hwinfo restart asked");
        r["text"] = "Restarting HWiNFO..."; Post(r);
        System.Threading.ThreadPool.QueueUserWorkItem(delegate
        {
            int code = exe == null || Elevated.Standard(exe) ? TaskRestart() : -9;   // (an HWiNFO of his choice somewhere else: the prompt's way, which starts that one)
            if (code != -9) Log("hwinfo restart by the task: " + code);
            // (no task to ask, or one that can't: an HWiNFO outside its installer's folder, an account without admin rights)
            if (code == -9 || code == 6 || code == 7) Try(() => BeginInvoke((Action)(() => PromptRestart(exe))));
            else Try(() => BeginInvoke((Action)(() => RestartDone(code))));
        });
    }
    // Restart HWiNFO through the task: the ask goes into this account's registry (only "now": what is restarted, and
    // how, is the task's own), the task is started, and its answer comes back the same way. -9: no task of this copy's
    // for this account, or Windows wouldn't start it; -1: no answer in time
    int TaskRestart()
    {
        if (KeepTaskVersion() < Elevated.TaskVersion || !Elevated.NetConfigClean()) return -9;
        long t = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        try { using (var k = Microsoft.Win32.Registry.CurrentUser.CreateSubKey(Elevated.Key)) k.SetValue("RestartAsked", t.ToString(System.Globalization.CultureInfo.InvariantCulture)); }
        catch { return -9; }
        if (!Elevated.StartTask()) return -9;
        for (int i = 0; i < 450; i++)
        {
            System.Threading.Thread.Sleep(200);
            int c; if (Elevated.Answered(t, out c)) return c;
        }
        return -1;
    }
    // this exe as admin, through one Windows prompt
    void PromptRestart(string exe)
    {
        try
        {
            var proc = Elevated.Prompt("--admin-restart " + Elevated.Arg(exe ?? ""));
            Log("hwinfo restart: through the Windows prompt");
            System.Threading.ThreadPool.QueueUserWorkItem(delegate
            {
                int code = -1;
                try { if (proc != null && proc.WaitForExit(90000)) code = proc.ExitCode; } catch { }
                Try(() => BeginInvoke((Action)(() => RestartDone(code))));
            });
        }
        catch (Exception ex)
        {
            restarting = false;
            var w = ex as System.ComponentModel.Win32Exception;
            var t = Msg("toast");
            if (w != null && w.NativeErrorCode == 1223) { t["text"] = "HWiNFO restart cancelled"; Post(t); Restarted(-2); return; }   // No in the Windows prompt
            Log("hwinfo restart failed: " + ex.Message); t["text"] = "Couldn't restart HWiNFO"; Post(t); Restarted(-1);
        }
    }
    void RestartDone(int code)
    {
        restarting = false;
        Log("hwinfo restart: " + code);
        var t = Msg("toast");
        t["text"] = code == 0 ? "HWiNFO restarted with its shared memory on" : code == 2 ? "HWiNFO restarted, but its settings file couldn't be changed: turn on Shared Memory Support in its settings"
                  : code == 3 ? "HWiNFO wasn't found: start it once yourself, " + Brand.Name + " remembers where it is"
                  : code == 4 ? "That HWiNFO isn't signed by its maker (REALiX), so " + Brand.Name + " didn't start it as admin" : "The HWiNFO restart didn't finish";
        Post(t); Restarted(code);
    }
    // the page's restart button spins until this comes (code 0: restarted with shared memory on)
    void Restarted(int code) { var m = Msg("restarted"); m["code"] = code; Post(m); }

    // ---- Keep HWiNFO sharing: the HWiNFO task (see Elevated: the installer makes it for the account installing; every
    // hour it restarts HWiNFO once it has run 10 h 50 min, so about every 11 h and always before the free version's 12 h,
    // in a quiet moment). On when the task is there, this copy's (after a move, the old folder's task starts nothing)
    // and this account's (one task per PC: another account's shows off), and not turned off here: on a task of version 6
    // or later the switch is this account's own setting (HKCU KeepOff), with no Windows prompt. With no task (another
    // account installed, or it was deleted) on makes one through one Windows prompt; an older task (a PowerShell script,
    // version 5 and before, which keeps working as it is) is deleted through one when turned off ----
    string KeepTask { get { return Elevated.TaskName; } }
    string KeepMark { get { return Elevated.TaskMark; } }
    bool keepBusy;   // the Windows prompt for the switch, or the change after it, under way
    // this copy's task for this account: its version (0: none, or not this copy's or this account's)
    int KeepTaskVersion()
    {
        if (fake) return 0;
        object svc = null;
        try
        {
            svc = Activator.CreateInstance(Type.GetTypeFromProgID("Schedule.Service"));
            Elevated.Com(svc, "Connect", Elevated.Call);
            object task = Elevated.Com(Elevated.Com(svc, "GetFolder", Elevated.Call, "\\"), "GetTask", Elevated.Call, KeepTask);   // (none: throws)
            object def = Elevated.Com(task, "Definition", Elevated.Get);
            string desc = Elevated.Com(Elevated.Com(def, "RegistrationInfo", Elevated.Get), "Description", Elevated.Get) as string, uid = Elevated.Com(Elevated.Com(def, "Principal", Elevated.Get), "UserId", Elevated.Get) as string;
            var me = System.Security.Principal.WindowsIdentity.GetCurrent();
            bool mine = string.IsNullOrEmpty(uid) || uid.Equals(me.User.Value, StringComparison.OrdinalIgnoreCase) || uid.Equals(me.Name, StringComparison.OrdinalIgnoreCase)
                     || uid.Equals(Environment.UserName, StringComparison.OrdinalIgnoreCase);
            if (!mine || !true.Equals(Elevated.Com(task, "Enabled", Elevated.Get)) || desc == null || !desc.EndsWith(KeepMark, StringComparison.OrdinalIgnoreCase)) return 0;
            var v = Regex.Match(desc, @"Task version (\d+)\.");
            return v.Success ? Math.Max(1, int.Parse(v.Groups[1].Value)) : 1;
        }
        catch { return 0; }
        finally { if (svc != null) Try(() => Marshal.ReleaseComObject(svc)); }
    }
    bool KeepSharing()
    {
        int v = KeepTaskVersion();
        if (v == 0 || (v >= Elevated.TaskVersion && Elevated.KeepOff())) return false;
        keepOld = v < 5;   // (5: the last PowerShell one, still fine as it is)
        try
        {
            using (var k = Microsoft.Win32.RegistryKey.OpenBaseKey(Microsoft.Win32.RegistryHive.LocalMachine, Microsoft.Win32.RegistryView.Registry64).OpenSubKey(Elevated.Key + @"\Keep"))
            { int c; if (k != null && int.TryParse((k.GetValue(KeepTask + " result") as string) ?? "", out c)) keepLast = c; }
        }
        catch { }
        if (!AdminAccount()) keepLast = 7;   // (its run stops there, and can't write that down)
        else if (v >= Elevated.TaskVersion && !Elevated.NetConfigClean()) keepLast = 11;   // (its cmd.exe doesn't start it, see Elevated.TaskXml)
        return true;
    }
    // the task's last result (it writes it in HKLM: Task Scheduler never sees it through conhost), and a task made by an
    // older HW Deck, read with KeepSharing
    int keepLast; bool keepOld;
    // the task is on but from an older HW Deck, or its last run couldn't restart HWiNFO: for under the switch (null: nothing)
    string KeepNote()
    {
        if (keepOld) return "Its task is from an older " + Brand.Name + ": turn this off and on once to update it.";
        string why = keepLast == 4 ? "that HWiNFO isn't signed by its maker (REALiX)" : keepLast == 6 ? "HWiNFO now runs from outside its default install folder"
                   : keepLast == 7 ? "this account isn't an admin anymore" : keepLast == 2 ? "it restarted HWiNFO, but couldn't change HWiNFO's settings file"
                   : keepLast == 11 ? "this account has settings for .NET programs in its registry (Software\\Microsoft\\.NETFramework), and it won't run as admin with those" : null;
        return why == null ? null : "Last time it couldn't keep HWiNFO sharing: " + why + ".";
    }
    void SetKeepSharing(bool on)
    {
        var r = Msg("toast");
        if (fake) { r["text"] = "Demo data: there is no HWiNFO to keep sharing"; Post(r); SendSettings(true); return; }
        if (Brand.NoActions) { r["text"] = "Test copy: no task is made or deleted"; Post(r); SendSettings(true); return; }
        if (keepBusy) { SendSettings(true); return; }
        string hw = settings.ContainsKey("hwinfo") ? settings["hwinfo"] as string : null;
        if (on && hw != null && !Elevated.Standard(hw)) { r["text"] = "Keep HWiNFO sharing only restarts HWiNFO in its default install folder, and yours runs from " + Path.GetDirectoryName(hw); Post(r); SendSettings(true); return; }
        int v = KeepTaskVersion();
        if (v >= Elevated.TaskVersion)   // (this account's own setting: no Windows prompt)
        {
            try { Elevated.SetKeepOff(!on); }
            catch (Exception ex) { Log("keep sharing failed: " + ex.Message); r["text"] = "Couldn't change Keep HWiNFO sharing: " + ex.Message; Post(r); SendSettings(true); return; }
            Log("keep sharing " + (on ? "on" : "off"));
            r["text"] = on ? "Keep HWiNFO sharing is on: HWiNFO restarts after about 11 hours" : "Keep HWiNFO sharing is off";
            Post(r); SendSettings(true); return;
        }
        if (on && Elevated.InstalledFolder() == null) { r["text"] = "Keep HWiNFO sharing needs " + Brand.Name + " installed with its installer"; Post(r); SendSettings(true); return; }
        if (!on && v == 0) { SendSettings(true); return; }   // (nothing of this copy's to turn off)
        try
        {
            // a task that runs as admin takes an admin to make (or delete): this exe, through one Windows prompt
            var proc = Elevated.Prompt("--admin-task " + (on ? "on " : "off ") + System.Security.Principal.WindowsIdentity.GetCurrent().User.Value);
            keepBusy = true;
            Log("keep sharing " + (on ? "on" : "off") + " asked");
            System.Threading.ThreadPool.QueueUserWorkItem(delegate
            {
                int code = -1;
                try { if (proc != null && proc.WaitForExit(60000)) code = proc.ExitCode; } catch { }
                Log("keep sharing " + (on ? "on: " : "off: ") + code);
                Try(() => BeginInvoke((Action)(() =>
                {
                    keepBusy = false;
                    if (on && code == 0) Try(() => Elevated.SetKeepOff(false));
                    var t = Msg("toast");
                    t["text"] = code == 8 ? "Keep HWiNFO sharing needs your own account to be an admin (Windows asked for another one)"
                              : code == 9 ? "Another account on this PC has Keep HWiNFO sharing on: there is one for the whole PC"
                              : code == 10 ? "Keep HWiNFO sharing needs " + Brand.Name + " installed with its installer"
                              : code == -1 ? "Couldn't turn Keep HWiNFO sharing " + (on ? "on" : "off") + ": Windows didn't finish the change in time"
                              : code != 0 ? "Couldn't turn Keep HWiNFO sharing " + (on ? "on" : "off")
                              : on ? "Keep HWiNFO sharing is on: HWiNFO restarts after about 11 hours" : "Keep HWiNFO sharing is off, and its task is deleted";
                    Post(t); SendSettings(true);
                })));
            });
        }
        catch (Exception ex)
        {
            var w = ex as System.ComponentModel.Win32Exception;
            if (w != null && w.NativeErrorCode == 1223) r["text"] = "Cancelled: Keep HWiNFO sharing stays " + (on ? "off" : "on");   // No in the Windows prompt
            else { Log("keep sharing failed: " + ex.Message); r["text"] = "Couldn't change Keep HWiNFO sharing: " + ex.Message; }
            Post(r); SendSettings(true);
        }
    }

    // ---- Accurate game fps (Frames): Windows lets admins and the Performance Log Users group trace frames. On unless
    // turned off here. The installer puts the account installing in that group (Elevated, noted in HKLM\Software\<name>\
    // PerfLogUsers, so the uninstall takes back only what HW Deck gave); an account not in it yet gets in through one
    // Windows prompt when it turns this on. A new group counts from the next sign-in. Off stops the counting only: the
    // group stays until the uninstall (taking it back took a prompt of its own). An account already in the group (or HW
    // Deck run as admin) needs no prompt ----
    const string PerfLogUsers = "S-1-5-32-559";
    bool fpsBusy;
    // the account in the group as Windows has it now (the sign-in's token may be older)
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(IntPtr token, int cls, out int info, int len, out int ret);
    // this account is an admin's: unelevated, Windows gives an admin a limited token (TokenElevationType 3); elevated, or
    // with UAC off, the token is in Administrators
    static bool AdminAccount()
    {
        try
        {
            using (var me = System.Security.Principal.WindowsIdentity.GetCurrent())
            {
                int t, n;
                if (GetTokenInformation(me.Token, 18, out t, 4, out n) && t == 3) return true;
                return new System.Security.Principal.WindowsPrincipal(me).IsInRole(System.Security.Principal.WindowsBuiltInRole.Administrator);
            }
        }
        catch { return true; }   // (can't tell: no note)
    }
    static bool InPerfLogUsers()
    {
        try { return Elevated.InGroup(PerfLogUsers, System.Security.Principal.WindowsIdentity.GetCurrent().User); }
        catch { return false; }
    }
    // for the page: on (counting) | signin (allowed from the next sign-in) | denied | failed | off (not wanted)
    string FpsState()
    {
        if (src.Frames == null || !FpsWanted) return "off";
        if (src.Frames.On) return "on";
        return src.Frames.State == "denied" ? (InPerfLogUsers() ? "signin" : "denied") : "failed";
    }
    void SetGameFps(bool on)
    {
        var r = Msg("toast");
        if (src.Frames == null) { r["text"] = "Demo data: there is no game to count"; Post(r); SendSettings(fpsDone: true); return; }
        if (Brand.NoActions) { r["text"] = "Test copy: Accurate game fps isn't changed"; Post(r); SendSettings(fpsDone: true); return; }
        if (fpsBusy) { SendSettings(fpsDone: true); return; }
        settings["gameFps"] = on; SaveSettings();
        if (!on) { src.Frames.Stop(); r["text"] = "Accurate game fps is off"; Post(r); SendSettings(fpsDone: true); return; }
        // (a trace that runs proves only this sign-in's token: the group is what decides)
        src.Frames.Start();
        if (src.Frames.State == "failed" || InPerfLogUsers() || new System.Security.Principal.WindowsPrincipal(System.Security.Principal.WindowsIdentity.GetCurrent()).IsInRole(System.Security.Principal.WindowsBuiltInRole.Administrator))
        { r["text"] = FpsText(); Post(r); SendSettings(fpsDone: true); return; }
        // into the group: this exe, through one Windows prompt
        try
        {
            var proc = Elevated.Prompt("--admin-fps " + System.Security.Principal.WindowsIdentity.GetCurrent().User.Value);
            fpsBusy = true;
            Log("game fps on: group change asked");
            System.Threading.ThreadPool.QueueUserWorkItem(delegate
            {
                int code = -1;
                try { if (proc != null && proc.WaitForExit(60000)) code = proc.ExitCode; } catch { }
                Log("game fps on: " + code);
                Try(() => BeginInvoke((Action)(() =>
                {
                    fpsBusy = false;
                    var t = Msg("toast");
                    if (code != 0 && code != 3) { settings["gameFps"] = false; SaveSettings(); src.Frames.Stop(); }   // (the trace started to try it stops too)
                    t["text"] = code != 0 && code != 3 ? "Couldn't turn Accurate game fps on" + (code == -1 ? ": Windows didn't finish the change in time" : "") : FpsText();
                    Post(t); SendSettings(fpsDone: true);
                })));
            });
        }
        catch (Exception ex)
        {
            var w = ex as System.ComponentModel.Win32Exception;
            bool no = w != null && w.NativeErrorCode == 1223;   // No in the Windows prompt
            settings["gameFps"] = false; SaveSettings(); src.Frames.Stop();
            if (!no) Log("game fps failed: " + ex.Message);
            r["text"] = no ? "Cancelled: Accurate game fps stays off" : "Couldn't change Accurate game fps: " + ex.Message;
            Post(r); SendSettings(fpsDone: true);
        }
    }
    string FpsText()
    {
        string st = FpsState();
        return st == "on" ? "Accurate game fps is on: " + Brand.Name + " counts the game's own frames" : st == "signin" ? "Almost: sign out of Windows and back in, and " + Brand.Name + " counts the game's own frames"
             : st == "denied" ? "Windows doesn't let this account count frames: turn this off and on to ask again" : "Couldn't start counting frames";
    }

    // ---- start with Windows: a Run entry for this exe, in the tray ----
    // on only when the entry starts this copy (after a move or a fresh unzip the old entry points elsewhere) and Task
    // Manager's Startup apps hasn't turned it off (StartupApproved: an odd first byte is disabled)
    const string ApprovedKey = @"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";
    bool Autostart()
    {
        try
        {
            using (var k = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(RunKey))
            {
                string v = k != null ? k.GetValue(runName) as string : null;
                if (v == null || v.IndexOf(Application.ExecutablePath, StringComparison.OrdinalIgnoreCase) < 0) return false;
            }
            using (var a = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(ApprovedKey))
            {
                var b = a != null ? a.GetValue(runName) as byte[] : null;
                return b == null || b.Length == 0 || (b[0] & 1) == 0;
            }
        }
        catch { return false; }
    }
    public static int Relaunches;   // the page's browser (or its GPU process) died and this copy was started again: how many times in a row
    int NextRelaunch() { return (DateTime.Now - Process.GetCurrentProcess().StartTime).TotalMinutes < 10 ? Relaunches + 1 : 1; }
    // a new copy that waits for this one to save and quit, and comes back as the window is now
    // (and for the page's browser too: one still closing would be joined by the new copy's page, GPU state and all)
    void Relaunch(int next)
    {
        Process.Start(Application.ExecutablePath, RestartArgs() + " --after " + Process.GetCurrentProcess().Id + (browserPid != 0 ? " --after-browser " + browserPid : "") + " --relaunch " + next + (Visible && !IsIconic(Handle) ? "" : " -min"));
        exiting = true; tray.Visible = false; Application.Exit();
    }
    uint browserPid;   // the page's WebView2 browser process
    bool gpuLost, gpuWaitLogged; int gpuLostAt;   // the page's GPU process died (ProcessFailed), at this TickCount
    // the new start for a lost GPU process: 30 s after the last loss (a driver install can take it down more than once);
    // a start that shows the window waits while a game or another full-screen app is in front (a new window can take
    // the focus); after two starts within minutes the next one waits until this copy has run 10 minutes
    bool MaybeGpuRestart()
    {
        if (!gpuLost || exiting || ending || asleep || unchecked(Environment.TickCount - gpuLostAt) < 30000) return false;
        if (Visible && !IsIconic(Handle) && (gameFront || FullScreenInFront())) return false;
        int next = NextRelaunch();
        if (next > 2) { if (!gpuWaitLogged) Log("the page's GPU process keeps closing: starting again once this copy has run 10 minutes"); gpuWaitLogged = true; return false; }
        gpuLost = false;
        Log("starting again: the page's GPU process closed");
        if (!Try(() => Relaunch(next))) Log("starting again failed");
        return exiting;
    }
    [DllImport("shell32.dll")] static extern int SHQueryUserNotificationState(out int state);
    static bool FullScreenInFront() { int q; return SHQueryUserNotificationState(out q) == 0 && (q == 2 || q == 3 || q == 4 || q == 7); }   // (busy: full screen, D3D full screen, presentation mode, a full-screen store app)
    public static readonly List<string> OtherArgs = new List<string>();   // what Main didn't know: a build's own switches
    string RestartArgs()
    {
        // a trailing backslash before the closing quote would escape it
        Func<string, string> q = a => a.Length > 0 && a.IndexOfAny(new[] { ' ', '\t', '"' }) < 0 ? a : "\"" + a.Replace("\"", "\\\"") + (a.EndsWith("\\") ? "\\" : "") + "\"";
        return ((customData ? "--data \"" + (dataDir.EndsWith("\\") ? dataDir + "\\" : dataDir) + "\"" : "") + (fake ? " --fake " + src.Inner.Readings.Count : "") +
                string.Concat(OtherArgs.Select(a => " " + q(a)))).Trim();
    }
    void SetAutostart(bool on)
    {
        if (Brand.NoActions) { var r = Msg("toast"); r["text"] = "Test copy: Start with Windows isn't changed"; Post(r); return; }
        try
        {
            using (var k = Microsoft.Win32.Registry.CurrentUser.CreateSubKey(RunKey))
            {
                if (on) k.SetValue(runName, "\"" + Application.ExecutablePath + "\" -min " + RestartArgs());
                else k.DeleteValue(runName, false);
            }
            // turned on here, it starts again even if Task Manager had it off (no approval entry: on)
            using (var a = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(ApprovedKey, true))
                if (a != null) a.DeleteValue(runName, false);
        }
        catch (Exception ex) { Log("autostart failed: " + ex.Message); var r = Msg("toast"); r["text"] = "Couldn't change Start with Windows"; Post(r); }
    }

    // ---- a slot to or from a file, to move a layout to another PC ----
    void Export(object data, string name)
    {
        using (var d = new SaveFileDialog { Filter = "HW Deck layout (*.json)|*.json", FileName = (string.IsNullOrEmpty(name) ? "layout" : Regex.Replace(name, @"[\\/:*?""<>|]", "")) + ".hwdeck.json" })
        {
            if (d.ShowDialog(this) != DialogResult.OK) return;
            var r = Msg("toast");
            try { File.WriteAllText(d.FileName, json.Serialize(new Dictionary<string, object> { { "hwdeck", 1 }, { "slot", data } }), new UTF8Encoding(false)); r["text"] = "Exported to " + Path.GetFileName(d.FileName); }
            catch (Exception ex) { Log("export failed: " + ex.Message); r["text"] = "Couldn't export: " + ex.Message; }
            Post(r);
        }
    }
    // ---- a headset theme to or from a file (11-14, plan T5: "for your friend"). The mouse never goes in it (its pieces
    // and its icon are left out). A test copy (--fake) may give the file's path instead of the dialog ----
    void HsExport(Dictionary<string, object> m)
    {
        var th = m.ContainsKey("theme") ? m["theme"] as Dictionary<string, object> : null; if (th == null) return;
        th.Remove("from"); th.Remove("name");
        object po; if (th.TryGetValue("pages", out po) && po is System.Collections.IEnumerable)
            foreach (var pg in (System.Collections.IEnumerable)po) { var pd = pg as Dictionary<string, object>; object qo; if (pd != null && pd.TryGetValue("pieces", out qo) && qo is System.Collections.IEnumerable) { var keep = new List<object>(); foreach (var q in (System.Collections.IEnumerable)qo) { var qd = q as Dictionary<string, object>; if (qd != null && !"mouse".Equals(qd.ContainsKey("src") ? qd["src"] : null)) { if ("mouse".Equals(qd.ContainsKey("src2") ? qd["src2"] : null)) qd["src2"] = null; keep.Add(q); } } pd["pieces"] = keep; } }
        var ic = th.ContainsKey("icons") ? th["icons"] as Dictionary<string, object> : null; if (ic != null) ic.Remove("mouse");
        object nmo; string name = m.TryGetValue("name", out nmo) ? nmo as string : null; if (string.IsNullOrWhiteSpace(name)) name = "Headset theme";
        string text = json.Serialize(new Dictionary<string, object> { { "hwdeck_headset", 1 }, { "name", name }, { "theme", th } });
        object pth; string path = fake && m.TryGetValue("path", out pth) ? pth as string : null;
        if (path == null)
            using (var d = new SaveFileDialog { Filter = "HW Deck headset theme (*.json)|*.json", FileName = Regex.Replace(name, @"[\\/:*?""<>|]", "") + ".headset.json" })
            {
                if (d.ShowDialog(this) != DialogResult.OK) return;
                path = d.FileName;
            }
        var r = Msg("toast");
        try { File.WriteAllText(path, text, new UTF8Encoding(false)); r["text"] = "Exported to " + Path.GetFileName(path); }
        catch (Exception ex) { Log("headset theme export failed: " + ex.Message); r["text"] = "Couldn't export: " + ex.Message; }
        Post(r);
    }
    void HsImport(Dictionary<string, object> m)
    {
        object pth; string path = fake && m.TryGetValue("path", out pth) ? pth as string : null;
        if (path == null)
            using (var d = new OpenFileDialog { Filter = "HW Deck headset theme (*.json)|*.json|All files|*.*" })
            {
                if (d.ShowDialog(this) != DialogResult.OK) return;
                path = d.FileName;
            }
        Dictionary<string, object> o = null;
        try { if (new FileInfo(path).Length < 2000000) o = json.DeserializeObject(File.ReadAllText(path)) as Dictionary<string, object>; } catch { }
        object tho, nmi; var th = o != null && o.ContainsKey("hwdeck_headset") && o.TryGetValue("theme", out tho) ? tho as Dictionary<string, object> : null;
        if (th == null) { var t = Msg("toast"); t["text"] = "Not a headset theme"; Post(t); return; }
        var r = Msg("hsimp"); r["name"] = (o.TryGetValue("name", out nmi) ? nmi as string : null) ?? "Imported"; r["theme"] = th;   // (checked by the host when it is set, like every change)
        Post(r);
    }
    void Import(int slot)
    {
        using (var d = new OpenFileDialog { Filter = "HW Deck layout (*.json)|*.json|All files|*.*" })
        {
            if (d.ShowDialog(this) != DialogResult.OK) return;
            var r = Msg("imported"); r["slot"] = slot;
            try
            {
                var o = json.DeserializeObject(File.ReadAllText(d.FileName)) as Dictionary<string, object>;
                r["data"] = o == null ? null : o.ContainsKey("slot") ? o["slot"] : o.ContainsKey("layout") ? o : null;   // (a bare slot too: older demo files)
            }
            catch { r["data"] = null; }
            Post(r);
        }
    }

    int lastDrag; Point lastDragAt; bool dragArmed;
    void Win(string a, bool tell = false)
    {
        // (a copy that never takes the focus, a test's, goes down and comes back without being activated even for a moment)
        if (a == "min") { if (NoFocus) ShowWindow(Handle, 7 /*SW_SHOWMINNOACTIVE*/); else KeepFocus(() => WindowState = FormWindowState.Minimized); }
        else if (a == "max" && NoFocus && WindowState == FormWindowState.Minimized) ShowWindow(Handle, 4 /*SW_SHOWNOACTIVATE: back as it was*/);
        else if (a == "max" && NoFocus)
        {
            // (maximized or restored without being activated: restoring is SW_SHOWNOACTIVATE; maximizing has no such
            // command, so: down without activation, told to come back maximized, back without activation)
            if (WindowState == FormWindowState.Maximized) ShowWindow(Handle, 4 /*SW_SHOWNOACTIVATE*/);
            else
            {
                ShowWindow(Handle, 7 /*SW_SHOWMINNOACTIVE*/);
                var wp = new WINDOWPLACEMENT { length = Marshal.SizeOf(typeof(WINDOWPLACEMENT)) };
                if (GetWindowPlacement(Handle, ref wp)) { wp.flags |= 2 /*WPF_RESTORETOMAXIMIZED*/; wp.showCmd = 7; SetWindowPlacement(Handle, ref wp); }
                ShowWindow(Handle, 4 /*SW_SHOWNOACTIVATE*/);
            }
            SaveWin(true);
        }
        else if (a == "max") { KeepFocus(() => WindowState = WindowState == FormWindowState.Maximized ? FormWindowState.Normal : FormWindowState.Maximized); SaveWin(true); }
        else if (a == "close") HideToTray();
        else if ((a == "drag" || a != null && a.StartsWith("resize:")) && NoFocus) { if (a == "drag" && tell) DragEnd(false); }   // (only a real mouse moves a window: in a test's copy they'd activate it; a press there is a click)
        else if (a == "drag")
        {
            // a second press on the title bar within the double-click time: maximize or restore, as a caption does;
            // else Windows moves the window (a maximized one comes out of maximize as it is dragged)
            int now = Environment.TickCount; var at = Cursor.Position;
            bool dbl = dragArmed && now - lastDrag < SystemInformation.DoubleClickTime && Math.Abs(at.X - lastDragAt.X) <= SystemInformation.DoubleClickSize.Width && Math.Abs(at.Y - lastDragAt.Y) <= SystemInformation.DoubleClickSize.Height;
            dragArmed = !dbl; lastDrag = now; lastDragAt = at;
            if (dbl) { Win("max"); if (tell) DragEnd(true); }
            else if (ButtonDown())   // (a tap's mousedown comes after the finger is up: no move loop with nothing held)
            {
                // (tell: the page asked how it ends, a popup's dim over the title bar was pressed: moved, the popup
                // stays; let go where it was, the page closes the popup as a click on its dim does. 11-11)
                var was = Bounds; var st = WindowState;
                ReleaseCapture(); SendMessage(Handle, WM_NCLBUTTONDOWN, 2, 0);
                if (tell) DragEnd(Bounds != was || WindowState != st);
            }
            else if (tell) DragEnd(false);
        }
        else if (a != null && a.StartsWith("resize:") && WindowState != FormWindowState.Maximized)
        {
            var map = new Dictionary<string, int> { { "l", 10 }, { "r", 11 }, { "t", 12 }, { "tl", 13 }, { "tr", 14 }, { "b", 15 }, { "bl", 16 }, { "br", 17 } };
            int ht;
            if (map.TryGetValue(a.Substring(7), out ht) && ButtonDown()) { ReleaseCapture(); SendMessage(Handle, WM_NCLBUTTONDOWN, ht, 0); }
        }
    }
    void DragEnd(bool moved) { var r = Msg("dragEnd"); r["moved"] = moved; Post(r); }   // (how a drag the page asked about ended: see Win)
    static bool ButtonDown() { return (Control.MouseButtons & (MouseButtons.Left | MouseButtons.Right)) != 0; }   // (either: swapped buttons)

    [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }
    [StructLayout(LayoutKind.Sequential)] struct WINDOWPLACEMENT { public int length, flags, showCmd, minX, minY, maxX, maxY; public RECT normal; }
    [DllImport("user32.dll")] static extern bool GetWindowPlacement(IntPtr h, ref WINDOWPLACEMENT wp);
    [DllImport("user32.dll")] static extern bool SetWindowPlacement(IntPtr h, ref WINDOWPLACEMENT wp);
    [StructLayout(LayoutKind.Sequential)] struct APPBARDATA { public uint cbSize; public IntPtr hWnd; public uint uCallbackMessage; public uint uEdge; public RECT rc; public IntPtr lParam; }
    [DllImport("shell32.dll")] static extern IntPtr SHAppBarMessage(uint msg, ref APPBARDATA data);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int hgt, uint flags);

    bool asleep, ending;                    // asleep: from PBT_APMSUSPEND to the wake; ending: Windows asked to end the session
    int sleptAt;

    // no native caption, but the resize frame stays: snapping, animations and maximize work like any window
    // the smallest the window goes, in its monitor's pixels: given in WM_GETMINMAXINFO, not by MinimumSize, whose setter
    // calls SetWindowPos without SWP_NOACTIVATE and so brings HW Deck to the front (at its start, or behind a game when
    // a monitor's scale changes)
    Size minTrack;
    // the monitors on or off (GUID_CONSOLE_DISPLAY_STATE): the headset base goes dark while they are off (his 11-13 burn in)
    static readonly Guid DisplayState = new Guid("6FE69556-704A-47A0-8F24-C28D936FDA47");
    [DllImport("user32.dll")] static extern IntPtr RegisterPowerSettingNotification(IntPtr h, ref Guid g, int flags);
    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        try { var g = DisplayState; RegisterPowerSettingNotification(Handle, ref g, 0); } catch { }   // (Windows sends the state now, then each change)
    }
    protected override void WndProc(ref Message m)
    {
        // Alt+F4, the taskbar's Close window: to the tray here, before WinForms notes the close as the user's (it keeps
        // that after a cancel, so a later WM_CLOSE from Task Manager or taskkill would hide it instead of quitting)
        // a WM_CLOSE gets here only from outside now (Task Manager, taskkill): a quit, so a launch meanwhile starts after it
        if (m.Msg == 0x0010 /*WM_CLOSE*/ && !exiting) exiting = true;
        if (m.Msg == 0x0112 /*WM_SYSCOMMAND*/ && ((int)m.WParam & 0xFFF0) == 0xF060 /*SC_CLOSE*/ && !exiting) { SaveWin(false, "the X, to the tray"); HideToTray(); return; }
        // a copy that never takes the focus (a test's) that still gets activated hands it straight back to the window that
        // was in front (otherFront, kept by the Tick)
        if (NoFocus && m.Msg == 0x0006 /*WM_ACTIVATE*/ && ((int)m.WParam & 0xFFFF) != 0 && otherFront != IntPtr.Zero && otherFront != Handle)
        { var w = otherFront; BeginInvoke((Action)(() => { if (GetForegroundWindow() == Handle) SetForegroundWindow(w); })); }
        if (m.Msg == 0x0024 /*WM_GETMINMAXINFO*/)
        {
            base.WndProc(ref m);
            if (!minTrack.IsEmpty && m.LParam != IntPtr.Zero) { Marshal.WriteInt32(m.LParam, 24, minTrack.Width); Marshal.WriteInt32(m.LParam, 28, minTrack.Height); }   // ptMinTrackSize
            return;
        }
        if (m.Msg == 0x0218 /*WM_POWERBROADCAST*/)
        {
            long pbt = m.WParam.ToInt64();
            // going to sleep: open episodes end here, not after the wake with the whole sleep in them
            if (pbt == 4 /*PBT_APMSUSPEND*/ && !asleep) { asleep = true; sleptAt = Environment.TickCount; alerts.Mark("PC going to sleep"); WriteAlerts(); Try(SaveData); FlushPage(); }   // (a power cut while asleep loses nothing)
            else if (pbt == 0x12 /*PBT_APMRESUMEAUTOMATIC*/ || pbt == 7 /*PBT_APMRESUMESUSPEND*/) asleep = false;
            else if (pbt == 0x8013 /*PBT_POWERSETTINGCHANGE*/ && m.LParam != IntPtr.Zero && (Guid)Marshal.PtrToStructure(m.LParam, typeof(Guid)) == DisplayState)
                Batt.DisplaysOff = Marshal.ReadInt32(m.LParam, 20) == 0;   // (POWERBROADCAST_SETTING: the guid, its length, then 0 off, 1 on, 2 dimmed)
        }
        else if (m.Msg == 0x11 /*WM_QUERYENDSESSION*/) { ending = true; FlushPage(); }   // (the page's waiting saves now, 11-17)
        // minimized: the next tick that finds it on screen says so (shown), even after a minimize too short for any
        // tick to have seen
        // (and when it hid, as the tick does for the tray: the restore sends only the seconds missed, 11-06)
        else if (m.Msg == 0x05 /*WM_SIZE*/ && m.WParam.ToInt64() == 1 /*SIZE_MINIMIZED*/) { if (wasShowing) hiddenAt = Source.Unix(); wasShowing = false; }
        else if (m.Msg == 0x16 /*WM_ENDSESSION*/)
        {
            if (m.WParam != IntPtr.Zero) { tray.Visible = false; EndMark(); exiting = true; BeginInvoke((Action)Application.Exit); }   // the session ends (or an installer asked): quit
            else ending = false;   // another app cancelled it: carry on
        }
        if (m.Msg == 0x02E0 /*WM_DPICHANGED*/)
        {
            // another monitor, another scale: take the size Windows suggests and a minimum in that monitor's pixels
            int dpi = (int)(m.WParam.ToInt64() & 0xFFFF);
            var r = (RECT)Marshal.PtrToStructure(m.LParam, typeof(RECT));
            var wa = Screen.FromRectangle(Rectangle.FromLTRB(r.L, r.T, r.R, r.B)).WorkingArea;
            minTrack = new Size(Math.Min(720 * dpi / 96, wa.Width / 2), Math.Min(480 * dpi / 96, wa.Height / 2));
            SetWindowPos(Handle, IntPtr.Zero, r.L, r.T, r.R - r.L, r.B - r.T, 0x0004 /*NOZORDER*/ | 0x0010 /*NOACTIVATE*/);
            BeginInvoke((Action)FitToScreen);
            m.Result = IntPtr.Zero;
            return;
        }
        // a restore: maximized or minimized at the last of these, neither now, in Windows' word (WinForms' WindowState
        // already says normal by then; see SetBoundsCore)
        if (m.Msg == 0x0047 /*WM_WINDOWPOSCHANGED*/)
        {
            bool minMax = IsZoomed(m.HWnd) || IsIconic(m.HWnd), restore = wasMinMax && !minMax;
            wasMinMax = minMax;
            RECT w;
            if (restore && GetWindowRect(m.HWnd, out w) && w.R > w.L && w.B > w.T)
            {
                restoring = Rectangle.FromLTRB(w.L, w.T, w.R, w.B);
                try { base.WndProc(ref m); } finally { restoring = Rectangle.Empty; }
                return;
            }
        }
        if (m.Msg == 0x83 /*WM_NCCALCSIZE*/ && m.WParam != IntPtr.Zero)
        {
            RECT before = (RECT)Marshal.PtrToStructure(m.LParam, typeof(RECT));
            base.WndProc(ref m);
            RECT after = (RECT)Marshal.PtrToStructure(m.LParam, typeof(RECT));
            int frame = 8;
            try { uint dpi = GetDpiForWindow(Handle); if (dpi > 0) frame = GetSystemMetricsForDpi(33, dpi) + GetSystemMetricsForDpi(92, dpi); } catch { }
            // maximized, the window reaches past the screen by its frame: the page starts at the screen's top. Asked of
            // Windows (IsZoomed), not of WindowState: maximizing from the title bar or the button calls this before
            // WindowState says so, and the top of the page went under the screen's edge (only a start from the tray
            // got it right)
            after.T = IsZoomed(m.HWnd) ? before.T + frame : before.T;
            if (IsZoomed(m.HWnd))
                try
                {
                    // an auto-hide taskbar on an edge of this screen comes up when the pointer reaches that edge: a
                    // window covering all of it would never let it, so that edge keeps 2 px free
                    var mb = Screen.FromRectangle(Rectangle.FromLTRB(before.L, before.T, before.R, before.B)).Bounds;   // (where it goes: moving to another screen, the window is still on the old one)
                    for (uint edge = 0; edge < 4; edge++)
                    {
                        var ab = new APPBARDATA { cbSize = (uint)Marshal.SizeOf(typeof(APPBARDATA)), uEdge = edge, rc = new RECT { L = mb.Left, T = mb.Top, R = mb.Right, B = mb.Bottom } };
                        if (SHAppBarMessage(0x0B /*ABM_GETAUTOHIDEBAREX*/, ref ab) == IntPtr.Zero) continue;
                        if (edge == 0) after.L = Math.Max(after.L, mb.Left + 2); else if (edge == 1) after.T = Math.Max(after.T, mb.Top + 2);
                        else if (edge == 2) after.R = Math.Min(after.R, mb.Right - 2); else after.B = Math.Min(after.B, mb.Bottom - 2);
                    }
                }
                catch { }
            Marshal.StructureToPtr(after, m.LParam, false);
            m.Result = IntPtr.Zero;
            return;
        }
        base.WndProc(ref m);
    }
    // back from maximized or minimized, the window keeps the place Windows restores it to. WinForms keeps its own: the
    // client size from when it left normal, made into a window size with a native caption (the caption is the page's,
    // WM_NCCALCSIZE above), so each un-maximize or restore from the taskbar made the window a caption taller (11-03: 65
    // px at 225%, three times in his dashboard's log on 11-02). It puts that back through SetBoundsCore while it handles
    // the WM_WINDOWPOSCHANGED of the restore (a non-virtual SizeFromClientSize, so that can't be the hook): then,
    // Windows' place
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    Rectangle restoring; bool wasMinMax;
    protected override void SetBoundsCore(int x, int y, int width, int height, BoundsSpecified specified)
    {
        if (!restoring.IsEmpty) { x = restoring.X; y = restoring.Y; width = restoring.Width; height = restoring.Height; }
        base.SetBoundsCore(x, y, width, height, specified);
    }

    // a window bigger than its screen's work area (another screen's scale, a smaller second screen, a size saved on another
    // monitor) comes back inside it, never under the taskbar
    // (a monitor change in the middle of a drag waits for the drag to end: the window still straddles both screens)
    bool moving, fitAfterMove;
    Rectangle movedFrom;
    void FitToScreen()
    {
        try
        {
            if (WindowState != FormWindowState.Normal || !IsHandleCreated) return;
            if (moving) { fitAfterMove = true; return; }
            // what shows: Bounds also holds the invisible resize borders (left, right, bottom), which may sit off the
            // work area (a window snapped to an edge)
            var wa = Screen.FromHandle(Handle).WorkingArea; var b = Bounds; var v = b;
            RECT e; if (DwmGetWindowAttribute(Handle, 9 /*DWMWA_EXTENDED_FRAME_BOUNDS*/, out e, Marshal.SizeOf(typeof(RECT))) == 0 && e.R > e.L && e.B > e.T) v = Rectangle.FromLTRB(e.L, e.T, e.R, e.B);
            int l = v.Left - b.Left, t = v.Top - b.Top, r = b.Right - v.Right, bo = b.Bottom - v.Bottom;
            int w = Math.Min(v.Width, wa.Width), h = Math.Min(v.Height, wa.Height);   // only what sticks out: a window that fits stays as it is
            int x = Math.Max(wa.Left, Math.Min(v.Left, wa.Right - w)), y = Math.Max(wa.Top, Math.Min(v.Top, wa.Bottom - h));
            if (w != v.Width || h != v.Height || x != v.Left || y != v.Top) Bounds = new Rectangle(x - l, y - t, w + l + r, h + t + bo);
        }
        catch { }
    }
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);
    string WinPath { get { return P("window.json"); } }
    // the saved place on a screen that isn't there (a TV that is off, a monitor unplugged): the window shows elsewhere
    // meanwhile, window.json keeps the place, and the window goes back once that screen is (WinBack); moving or resizing
    // it yourself (mine) makes where it is the saved place
    Rectangle winSaved, winAway, normalAt;   // normalAt: where it was last neither maximized nor minimized (RestoreBounds misses moves made outside WinForms)
    bool winSavedMax, winAwayMax, winHome = true;   // winHome: at the last look the window was on its saved place
    void NoteNormal() { if (IsHandleCreated && !IsZoomed(Handle) && !IsIconic(Handle)) normalAt = Bounds; }   // (Windows' word: WindowState lags)
    void SaveWin(bool mine = false, string why = null)
    {
        try
        {
            if (mine) winAway = Rectangle.Empty;
            else { WinGone(); if (!winAway.IsEmpty) return; }   // (a save in the second its screen went: not the place Windows moved it to)
            var b = WindowState == FormWindowState.Normal ? Bounds : !normalAt.IsEmpty ? normalAt : RestoreBounds;
            bool max = WindowState == FormWindowState.Maximized || (WindowState == FormWindowState.Minimized && restoreMax);   // minimized from maximized comes back maximized
            var d = new Dictionary<string, object> { { "x", b.X }, { "y", b.Y }, { "w", b.Width }, { "h", b.Height }, { "max", max } };
            uint dpi = IsHandleCreated ? GetDpiForWindow(Handle) : 0;
            if (dpi > 0) d["dpi"] = (int)dpi;   // (the size is in that screen's pixels: shown on another scale, it is converted)
            Disk.Swap(WinPath, json.Serialize(d));   // (a cut write never empties it)
            // (his 11-02 report "it always opens at the same size, never the one I resize it to": each new size goes to
            // app.log with what saved it, so the step that loses it shows)
            if (b != winSaved || max != winSavedMax) Log("window saved " + WinTxt(b, max) + (dpi > 0 ? " at " + dpi + " dpi" : "") + (mine ? ", moved or resized" : ", " + (why ?? (exiting ? "quitting" : ending ? "Windows ending the session" : Visible ? "closed or a change" : "to the tray"))));
            winSaved = b; winSavedMax = max;
        }
        catch { }
    }
    Rectangle winAsked;   // the place window.json gave it, for the log when Windows puts it elsewhere
    static string WinTxt(Rectangle b, bool max) { return b.Width + "x" + b.Height + " at " + b.X + "," + b.Y + (max ? " maximized" : ""); }
    void RestoreWin()
    {
        try
        {
            if (!File.Exists(WinPath)) return;
            var d = json.Deserialize<Dictionary<string, object>>(File.ReadAllText(WinPath));
            var r = new Rectangle(Convert.ToInt32(d["x"]), Convert.ToInt32(d["y"]), Convert.ToInt32(d["w"]), Convert.ToInt32(d["h"]));
            bool max = true.Equals(d["max"]);
            winSaved = r; winSavedMax = max;
            if (!OnAScreen(r))
            {
                // its screen isn't there: the saved size, in the middle of the screen under the mouse (in its pixels)
                winAway = r; winAwayMax = max;
                var sc = Screen.FromPoint(Cursor.Position);
                if (!OnAScreen(sc.Bounds)) sc = Screen.PrimaryScreen;
                var wa = sc.WorkingArea; var c = new RECT { L = wa.X + wa.Width / 2, T = wa.Y + wa.Height / 2, R = wa.X + wa.Width / 2 + 1, B = wa.Y + wa.Height / 2 + 1 };
                object was; uint dx, dy;
                double k = d.TryGetValue("dpi", out was) && Convert.ToInt32(was) > 0 && GetDpiForMonitor(MonitorFromRect(ref c, 2 /*NEAREST*/), 0, out dx, out dy) == 0 && dx > 0 ? (double)dx / Convert.ToInt32(was) : 1;
                int w = Math.Min((int)(r.Width * k), wa.Width), h = Math.Min((int)(r.Height * k), wa.Height);
                r = new Rectangle(wa.X + (wa.Width - w) / 2, wa.Y + (wa.Height - h) / 2, w, h);
            }
            minTrack = Size.Empty;   // HandleCreated sets the one for the monitor it is on
            StartPosition = FormStartPosition.Manual; Bounds = r; normalAt = r; winAsked = r;
            Log("window opens " + WinTxt(r, max) + (winAway.IsEmpty ? ", as saved" : ", saved " + WinTxt(winAway, max) + " on a screen that isn't there"));
            if (max && !NoFocus && winAway.IsEmpty) WindowState = FormWindowState.Maximized;   // (a maximized first show takes the focus; away, it maximizes once back there)
        }
        catch { }
    }
    [DllImport("user32.dll")] static extern IntPtr MonitorFromRect(ref RECT r, uint flags);
    [DllImport("shcore.dll")] static extern int GetDpiForMonitor(IntPtr mon, int type, out uint x, out uint y);
    int goneFrom = -1, goneTo; DateTime goneAt;
    // a screen there now, asked of Windows each time (Screen keeps its list from the last display change it heard of)
    bool OnAScreen(Rectangle r)
    {
        var rc = new RECT { L = r.Left, T = r.Top, R = r.Right, B = r.Bottom };
        IntPtr m = MonitorFromRect(ref rc, 0 /*MONITOR_DEFAULTTONULL*/);
        if (m == IntPtr.Zero) return false;
        if (goneFrom < 0) return true;
        double t = (DateTime.UtcNow - goneAt).TotalSeconds;
        var p = new RECT { L = 0, T = 0, R = 1, B = 1 };
        return t < goneFrom || t >= goneTo || m == MonitorFromRect(ref p, 1 /*MONITOR_DEFAULTTOPRIMARY*/);
    }
    // the saved place's screen gone while the window was on it (Windows moves it elsewhere): that place is kept. A
    // window you moved off it some other way (keys) isn't brought back
    void WinGone()
    {
        if (!winAway.IsEmpty || winSaved.IsEmpty) return;
        if (OnAScreen(winSaved)) { winHome = (WindowState == FormWindowState.Normal ? Bounds : normalAt).IntersectsWith(winSaved); return; }
        if (winHome) { winAway = winSaved; winAwayMax = winSavedMax; }
    }
    // once a second, and as it opens from the tray: the saved place's screen back, the window goes there, never taking
    // the focus (a game may be in front)
    void WinBack()
    {
        if (winAway.IsEmpty) { WinGone(); return; }
        if (moving || !IsHandleCreated || !OnAScreen(winAway)) return;
        var r = winAway; bool max = winAwayMax;
        if (!Visible)
        {
            if (WindowState != FormWindowState.Normal) return;   // (in the tray maximized or minimized: once it shows)
            winAway = Rectangle.Empty; MoveTo(r);
            if (max) WindowState = FormWindowState.Maximized;   // (hidden: it opens that way)
        }
        else if (!max && WindowState == FormWindowState.Normal) { winAway = Rectangle.Empty; MoveTo(r); }
        else if (max && IsZoomed(Handle) && Screen.FromHandle(Handle).Bounds == Screen.FromRectangle(r).Bounds) { winAway = Rectangle.Empty; normalAt = r; }   // (back there already: Windows puts windows back too)
        else if (GetForegroundWindow() == Handle && !IsIconic(Handle))
        {
            winAway = Rectangle.Empty;   // (in front already: no focus to take)
            WindowState = FormWindowState.Normal; MoveTo(r);
            if (max) WindowState = FormWindowState.Maximized;
        }
        else
        {
            // maximized, or to be: the place set while minimized without activation, then back (as a test's copy maximizes)
            winAway = Rectangle.Empty; normalAt = r;
            bool wasMin = WindowState == FormWindowState.Minimized;
            if (!wasMin) ShowWindow(Handle, 7 /*SW_SHOWMINNOACTIVE*/);
            var wp = new WINDOWPLACEMENT { length = Marshal.SizeOf(typeof(WINDOWPLACEMENT)) };
            if (GetWindowPlacement(Handle, ref wp))
            {
                // (the restored place is in workspace coordinates: off by where that screen's work area starts)
                var sc = Screen.FromRectangle(r); int ox = sc.WorkingArea.X - sc.Bounds.X, oy = sc.WorkingArea.Y - sc.Bounds.Y;
                wp.normal = new RECT { L = r.Left - ox, T = r.Top - oy, R = r.Right - ox, B = r.Bottom - oy };
                wp.flags = max ? wp.flags | 2 /*WPF_RESTORETOMAXIMIZED*/ : wp.flags & ~2; wp.showCmd = 7;
                SetWindowPlacement(Handle, ref wp);
            }
            if (!wasMin) ShowWindow(Handle, 4 /*SW_SHOWNOACTIVATE*/);
        }
        SaveWin();
    }
    // (twice: the first move to a screen of another scale comes back at Windows' size for it, see WM_DPICHANGED; then
    // inside that screen, which may have come back at another size)
    void MoveTo(Rectangle r) { for (int i = 0; i < 2; i++) SetWindowPos(Handle, IntPtr.Zero, r.X, r.Y, r.Width, r.Height, 0x0004 /*NOZORDER*/ | 0x0010 /*NOACTIVATE*/); FitToScreen(); }

    // made-up data (tests, demos), or HWDECK_NOFOCUS=1 (a test copy on real data): opens without taking the focus from
    // whatever you are working in
    bool NoFocus { get { return fake || Environment.GetEnvironmentVariable("HWDECK_NOFOCUS") == "1"; } }
    protected override bool ShowWithoutActivation { get { return NoFocus; } }
    IntPtr focusAtStart;   // NoFocus: what had the focus when this copy started, given back if the first show took it
    protected override void OnShown(EventArgs e)
    {
        base.OnShown(e);
        if (focusAtStart != IntPtr.Zero && focusAtStart != Handle && GetForegroundWindow() == Handle) SetForegroundWindow(focusAtStart);
        focusAtStart = IntPtr.Zero;
    }
    protected override void SetVisibleCore(bool value)
    {
        if (startHidden) { startHidden = false; base.SetVisibleCore(false); if (!IsHandleCreated) CreateHandle(); return; }
        base.SetVisibleCore(value);
    }

    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    // a copy that keeps the focus (NoFocus): a window change that took it gives it back to whatever had it (once the
    // focus is ours, handing it back is allowed)
    void KeepFocus(Action a)
    {
        IntPtr was = NoFocus ? GetForegroundWindow() : IntPtr.Zero;
        a();
        if (was != IntPtr.Zero && was != Handle && GetForegroundWindow() == Handle) SetForegroundWindow(was);
    }
    public volatile bool showAsked;         // a second launch before this window existed
    public bool Quitting { get { return exiting; } }   // (a second launch's show signal isn't answered then)
    public void ShowWin()
    {
        if (!IsHandleCreated) { showAsked = true; return; }
        showAsked = false;
        Try(WinBack);   // (its saved place's screen back while it was in the tray: it opens there)
        Try(() => wv.Visible = true);
        // (a copy that never takes the focus comes back without being activated: a restore through WindowState activates,
        // SW_SHOWNOACTIVATE brings a minimized window back as it was, maximized or not)
        // (not Show(): for a form hidden while minimized or maximized it uses SW_SHOWMINIMIZED / SW_SHOWMAXIMIZED, which activate)
        // (SW_SHOWNOACTIVATE keeps a normal window's place under the others; minimized or maximized, SW_SHOWNA shows it as it was)
        if (NoFocus) { ShowWindow(Handle, WindowState == FormWindowState.Normal ? 4 /*SW_SHOWNOACTIVATE*/ : 8 /*SW_SHOWNA*/); if (IsIconic(Handle)) ShowWindow(Handle, 4); BeginInvoke((Action)FitToScreen); return; }
        Show();
        if (WindowState == FormWindowState.Minimized) WindowState = restoreMax ? FormWindowState.Maximized : FormWindowState.Normal;
        Activate(); SetForegroundWindow(Handle);
        BeginInvoke((Action)FitToScreen);   // (its monitor may be gone since it went to the tray)
    }
}

// diagnostics (HWDECK_TRACE=1 only): what the UI thread handles each second, how late the 250 ms timer and a probe
// posted every 50 ms from another thread run; written to trace.log in the data folder
static class UiTrace
{
    public static bool on; static Control ui; static string file;
    static readonly Stopwatch sw = Stopwatch.StartNew();
    static long lastTimer, maxTimerGap, maxProbe; static readonly Dictionary<int, int> counts = new Dictionary<int, int>();
    class Filter : IMessageFilter { public bool PreFilterMessage(ref Message m) { lock (counts) { int c; counts.TryGetValue(m.Msg, out c); counts[m.Msg] = c + 1; } return false; } }
    static System.Threading.Thread uiThread; static long probeSent = -1;
    public static void Start(Control c, string path)
    {
        on = true; ui = c; file = path; lastTimer = sw.ElapsedMilliseconds; uiThread = System.Threading.Thread.CurrentThread;
        Application.AddMessageFilter(new Filter());
        new System.Threading.Thread(() => {
            long lastLog = sw.ElapsedMilliseconds;
            while (true) {
                System.Threading.Thread.Sleep(50);
                long sent = sw.ElapsedMilliseconds;
                // a probe still waiting after 300 ms: the UI thread is stuck; write down where (once per stall)
                if (probeSent >= 0 && sent - probeSent > 300) {
                    probeSent = -2;
                    try {
#pragma warning disable 618
                        uiThread.Suspend(); string st;
                        try { st = new StackTrace(uiThread, false).ToString(); } finally { uiThread.Resume(); }
#pragma warning restore 618
                        File.AppendAllText(file, DateTime.Now.ToString("HH:mm:ss.fff") + " STUCK, UI thread stack:" + Environment.NewLine + st + Environment.NewLine);
                    } catch (Exception ex) { try { File.AppendAllText(file, "stack failed: " + ex.Message + Environment.NewLine); } catch { } }
                }
                if (probeSent == -1) { probeSent = sent; long ps = sent; try { ui.BeginInvoke((Action)(() => { long d = sw.ElapsedMilliseconds - ps; if (d > maxProbe) maxProbe = d; probeSent = -1; })); } catch { probeSent = -1; } }
                if (sent - lastLog >= 1000) {
                    lastLog = sent; string line;
                    lock (counts) { line = DateTime.Now.ToString("HH:mm:ss.fff") + " probe max " + maxProbe + " ms, timer gap max " + maxTimerGap + " ms, msgs " + string.Join(" ", counts.OrderByDescending(x => x.Value).Take(8).Select(x => "0x" + x.Key.ToString("X") + "=" + x.Value)); counts.Clear(); }
                    maxProbe = 0; maxTimerGap = 0;
                    try { File.AppendAllText(file, line + Environment.NewLine); } catch { }
                }
            }
        }) { IsBackground = true }.Start();
    }
    public static long Now() { return sw.ElapsedMilliseconds; }
    public static void Took(string what, long since) { if (!on) return; long d = sw.ElapsedMilliseconds - since; if (d >= 40) try { File.AppendAllText(file, DateTime.Now.ToString("HH:mm:ss.fff") + " SLOW " + what + " " + d + " ms" + Environment.NewLine); } catch { } }
    public static void TimerFired() { if (!on) return; long t = sw.ElapsedMilliseconds, d = t - lastTimer; lastTimer = t; if (d > maxTimerGap) maxTimerGap = d; }
}

// ---- the admin work, done by this exe itself, never by a script (11-09: Windows Defender took HW Deck's hidden
// PowerShell, and the HWDeck.exe that carried it, for malware). One job per switch; none opens a window or takes the
// single-instance lock, so each runs beside a running HW Deck:
//   --install-setup <sid>   the installer, as SYSTEM once its files are in: that account goes into Performance Log Users
//                           (Accurate game fps) and gets the HWiNFO task (Keep HWiNFO sharing, and Restart HWiNFO with no
//                           Windows prompt), so both are on with no prompt but the install's own. An update does it
//                           again; a switch turned off in Settings stays off (that is Settings' own)
//   --uninstall-cleanup     the uninstall, as SYSTEM: the task, its notes, and the accounts HW Deck put in the group
//   --drop-run              the installer, as the user: a Start with Windows entry that starts this install goes
//   --hwinfo-task           the task, as its account with its admin rights: HWiNFO restarted once it has run about 11
//                           hours, or at once when Restart HWiNFO asks
//   --admin-task on|off <sid>, --admin-fps <sid>, --admin-restart <exe>: Settings and Restart HWiNFO through one Windows
//                           prompt, where the installer's setup isn't there (another account, an older task, an HWiNFO
//                           outside its installer's folder)
//   --check-hwinfo <exe>    0 when that file is signed by HWiNFO's maker (tests)
// Each job's exit codes are with it ----
static class Elevated
{
    public const System.Reflection.BindingFlags Call = System.Reflection.BindingFlags.InvokeMethod, Get = System.Reflection.BindingFlags.GetProperty;
    public static object Com(object o, string name, System.Reflection.BindingFlags how, params object[] a) { return o.GetType().InvokeMember(name, how, null, o, a); }
    static readonly string[] verbs = { "--install-setup", "--uninstall-cleanup", "--drop-run", "--hwinfo-task", "--admin-task", "--admin-fps", "--admin-restart", "--check-hwinfo" };
    public static bool IsVerb(string a) { return Array.IndexOf(verbs, (a ?? "").ToLowerInvariant()) >= 0; }
    // a test build's trace (its name ends in " Test"): every switch, in %TEMP%\hwdeck-test-run.txt
    public static void T(string m)
    {
        if (Brand.Name.EndsWith(" Test", StringComparison.Ordinal))
            try { File.AppendAllText(Path.Combine(Path.GetTempPath(), "hwdeck-test-run.txt"), AppInfo.Stamp() + " " + m + Environment.NewLine); } catch { }
    }
    public static int Run(string[] a)
    {
        string x = a.Length > 1 ? a[1] : null, y = a.Length > 2 ? a[2] : null;
        T(string.Join(" ", a) + " | " + Environment.CurrentDirectory);
        try
        {
            switch (a[0].ToLowerInvariant())
            {
                case "--install-setup": return InstallSetup(x);
                case "--uninstall-cleanup": return UninstallCleanup();
                case "--drop-run": return DropRun();
                case "--hwinfo-task": return HwinfoTask();
                case "--admin-task": return AdminTask(x, y);
                case "--admin-fps": return AdminFps(x);
                case "--admin-restart": return Restart(string.IsNullOrEmpty(x) ? null : x, false);
                case "--check-hwinfo": return x != null && ByRealix(x) ? 0 : 4;
            }
        }
        catch (Exception ex) { T("failed: " + ex); }
        return 1;
    }

    // HKLM\SOFTWARE\<name>: InstallFolder (the msi's), PerfLogUsers, Keep\<task> result; HKCU\SOFTWARE\<name>: KeepOff,
    // RestartAsked, RestartDone (this account's own)
    public static string Key { get { return @"SOFTWARE\" + Brand.Name; } }
    public static string TaskName { get { return Brand.Name + " - Keep HWiNFO sharing"; } }
    public static string TaskMark { get { return Brand.Name + ": " + Application.ExecutablePath; } }   // the end of its description: whose it is
    // in its description. 6: the task starts this exe (5 and before: a PowerShell script kept in HKLM, which still works
    // as it is). Bump it when TaskXml changes (test/e2e-hardening.mjs pins TaskXml to it)
    public const int TaskVersion = 6;
    const string PerfLogUsers = "S-1-5-32-559", Admins = "S-1-5-32-544";
    static Microsoft.Win32.RegistryKey Lm() { return Microsoft.Win32.RegistryKey.OpenBaseKey(Microsoft.Win32.RegistryHive.LocalMachine, Microsoft.Win32.RegistryView.Registry64); }
    static string LmGet(string sub, string name)
    {
        using (var b = Lm()) using (var k = b.OpenSubKey(sub)) return k != null ? k.GetValue(name) as string : null;
    }

    public static bool InProgramFiles(string exe)
    {
        try
        {
            string full = Path.GetFullPath(exe);
            return new[] { Environment.SpecialFolder.ProgramFiles, Environment.SpecialFolder.ProgramFilesX86 }.Select(Environment.GetFolderPath)
                .Any(d => d != "" && full.StartsWith(d.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase));
        }
        catch { return false; }
    }
    // this exe's folder when it is the msi's install (HKLM InstallFolder) under Program Files, named by cmd.exe without
    // quotes (see TaskXml): the only copy an admin task may start, since only an admin can change what is there (null: not)
    public static string InstalledFolder()
    {
        try
        {
            string f = LmGet(Key, "InstallFolder"), exe = Path.GetFullPath(Application.ExecutablePath);
            if (string.IsNullOrEmpty(f) || !string.Equals(Path.GetFullPath(Path.Combine(f, Path.GetFileName(exe))), exe, StringComparison.OrdinalIgnoreCase)) return null;
            string dir = Path.GetDirectoryName(exe);
            return InProgramFiles(exe) && dir.IndexOfAny("&|<>^%!\"()".ToCharArray()) < 0 ? dir : null;
        }
        catch { return null; }
    }

    // ---- Performance Log Users (Accurate game fps): who HW Deck put there is noted in HKLM (PerfLogUsers), so the
    // uninstall takes back only that ----
    [DllImport("netapi32.dll", CharSet = CharSet.Unicode)] static extern int NetLocalGroupAddMembers(string server, string group, int level, IntPtr buf, int n);
    [DllImport("netapi32.dll", CharSet = CharSet.Unicode)] static extern int NetLocalGroupDelMembers(string server, string group, int level, IntPtr buf, int n);
    [DllImport("netapi32.dll", CharSet = CharSet.Unicode)] static extern int NetLocalGroupGetMembers(string server, string group, int level, out IntPtr buf, int max, out int read, out int total, IntPtr resume);
    [DllImport("netapi32.dll", CharSet = CharSet.Unicode)] static extern int NetUserGetLocalGroups(string server, string user, int level, int flags, out IntPtr buf, int max, out int read, out int total);
    [DllImport("netapi32.dll")] static extern int NetApiBufferFree(IntPtr buf);
    // (the group's name in this Windows' language)
    static string GroupName(string sid) { string g = new System.Security.Principal.SecurityIdentifier(sid).Translate(typeof(System.Security.Principal.NTAccount)).Value; return g.Substring(g.IndexOf('\\') + 1); }
    public static bool InGroup(string group, System.Security.Principal.SecurityIdentifier who)
    {
        try
        {
            IntPtr buf; int read, total;
            if (NetLocalGroupGetMembers(null, GroupName(group), 0, out buf, -1, out read, out total, IntPtr.Zero) != 0) return false;
            try
            {
                for (int i = 0; i < read; i++)
                    if (new System.Security.Principal.SecurityIdentifier(Marshal.ReadIntPtr(buf, i * IntPtr.Size)).Equals(who)) return true;
            }
            finally { NetApiBufferFree(buf); }
        }
        catch { }
        return false;
    }
    // Windows' code: 0 done, 1378 in already, 1377 not in
    static int Member(string group, System.Security.Principal.SecurityIdentifier who, bool add)
    {
        var b = new byte[who.BinaryLength]; who.GetBinaryForm(b, 0);
        IntPtr p = Marshal.AllocHGlobal(b.Length), info = Marshal.AllocHGlobal(IntPtr.Size);
        try
        {
            Marshal.Copy(b, 0, p, b.Length); Marshal.WriteIntPtr(info, p);
            return add ? NetLocalGroupAddMembers(null, GroupName(group), 0, info, 1) : NetLocalGroupDelMembers(null, GroupName(group), 0, info, 1);
        }
        finally { Marshal.FreeHGlobal(info); Marshal.FreeHGlobal(p); }
    }
    static List<string> Noted() { return (LmGet(Key, "PerfLogUsers") ?? "").Split(';').Where(s => s.Length > 0).ToList(); }
    // 0 put in (and noted), 3 in already, 1 Windows refused
    static int AddToGroup(System.Security.Principal.SecurityIdentifier who)
    {
        if (InGroup(PerfLogUsers, who)) return 3;
        int e = Member(PerfLogUsers, who, true);
        if (e == 1378) return 3;
        if (e != 0) return 1;
        var l = Noted();
        if (!l.Contains(who.Value)) l.Add(who.Value);
        using (var b = Lm()) using (var k = b.CreateSubKey(Key)) k.SetValue("PerfLogUsers", string.Join(";", l));
        return 0;
    }
    // an admin's account (straight in Administrators, or through a group of the domain's): only its task can restart an
    // HWiNFO that runs as admin
    static bool IsAdmin(System.Security.Principal.SecurityIdentifier who)
    {
        if (InGroup(Admins, who)) return true;
        try
        {
            string name = who.Translate(typeof(System.Security.Principal.NTAccount)).Value, adm = GroupName(Admins);
            IntPtr buf; int read, total;
            if (NetUserGetLocalGroups(null, name, 0, 1 /*LG_INCLUDE_INDIRECT*/, out buf, -1, out read, out total) != 0) return false;
            try
            {
                for (int i = 0; i < read; i++)
                    if (string.Equals(Marshal.PtrToStringUni(Marshal.ReadIntPtr(buf, i * IntPtr.Size)), adm, StringComparison.OrdinalIgnoreCase)) return true;
            }
            finally { NetApiBufferFree(buf); }
        }
        catch { }
        return false;
    }
    // a person's account that Windows knows (local, Microsoft, domain or Entra): never SYSTEM or a service
    static System.Security.Principal.SecurityIdentifier Account(string sid)
    {
        try
        {
            var s = new System.Security.Principal.SecurityIdentifier(sid);
            if (!s.Value.StartsWith("S-1-5-21-", StringComparison.Ordinal) && !s.Value.StartsWith("S-1-12-1-", StringComparison.Ordinal)) return null;
            s.Translate(typeof(System.Security.Principal.NTAccount));
            return s;
        }
        catch { return null; }
    }

    // ---- the installer's and Settings' jobs ----
    // 0 done (what couldn't be done shows off in Settings), 2 not a person's account, 10 not the installed copy
    static int InstallSetup(string sid)
    {
        var who = Account(sid);
        if (who == null) return 2;
        string dir = InstalledFolder();
        if (dir == null) return 10;
        try { AddToGroup(who); } catch { }
        try { if (IsAdmin(who)) MakeTask(who, dir); } catch { }
        return 0;
    }
    // Keep HWiNFO sharing through a Windows prompt: 0 done, 8 Windows asked for another account (the task runs as this
    // one, with its admin rights), 9 another account's task is there, 10 (on) not the installed copy
    static int AdminTask(string onoff, string sid)
    {
        var me = System.Security.Principal.WindowsIdentity.GetCurrent().User;
        if (sid == null || me == null || me.Value != sid) return 8;
        if (onoff == "on") { string dir = InstalledFolder(); return dir == null ? 10 : MakeTask(me, dir); }
        return DeleteTask(me);
    }
    // Accurate game fps through a Windows prompt: that account into the group (an admin may let another one in): 0, 3 in
    // already, 2 not a person's account
    static int AdminFps(string sid) { var who = Account(sid); return who == null ? 2 : AddToGroup(who); }
    // the uninstall: the task (it starts this exe, which is going; the installer's schtasks line deletes it too), its
    // notes, and the accounts HW Deck put in Performance Log Users (only those: one that was in it before stays)
    static int UninstallCleanup()
    {
        try { DeleteTask(null); } catch { }
        foreach (var s in Noted()) try { Member(PerfLogUsers, new System.Security.Principal.SecurityIdentifier(s), false); } catch { }
        try { using (var b = Lm()) using (var k = b.OpenSubKey(Key, true)) if (k != null) k.DeleteValue("PerfLogUsers", false); } catch { }
        try
        {
            using (var b = Lm())
            {
                bool empty;
                using (var k = b.OpenSubKey(Key)) empty = k != null && k.ValueCount + k.SubKeyCount == 0;   // (the installer's own values went before this)
                if (empty) b.DeleteSubKey(Key, false);
            }
        }
        catch { }
        return 0;
    }
    const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run", ApprovedKey = @"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";
    // a Start with Windows entry that starts this install: one made in Settings belongs to no product, so the installer
    // can't take it away alone
    static int DropRun()
    {
        string f = LmGet(Key, "InstallFolder");
        if (string.IsNullOrEmpty(f)) return 0;
        using (var r = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(RunKey, true))
        {
            string v = r != null ? r.GetValue(Brand.Name) as string : null;
            if (v == null || v.IndexOf(f, StringComparison.OrdinalIgnoreCase) < 0) return 0;
            r.DeleteValue(Brand.Name, false);
        }
        using (var a = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(ApprovedKey, true)) if (a != null) a.DeleteValue(Brand.Name, false);
        return 0;
    }
    // this exe as admin through one Windows prompt (a No: Win32Exception 1223)
    public static Process Prompt(string args)
    {
        return Process.Start(new ProcessStartInfo(Application.ExecutablePath, args) { Verb = "runas", UseShellExecute = true, WindowStyle = ProcessWindowStyle.Hidden });
    }
    public static string Arg(string a) { a = (a ?? "").Replace("\"", ""); return "\"" + a + (a.EndsWith("\\") ? "\\" : "") + "\""; }

    // ---- the HWiNFO task ----
    // every 5 minutes from a minute after it is made (each look is over in a moment), and on demand (Restart HWiNFO), as
    // that account with its admin rights. It starts this exe through cmd.exe (its own extensions on, no AutoRun, no
    // delayed expansion, whatever the account set), which first refuses when the account's registry holds settings for
    // .NET programs (the profiler among them, which .NET reads from there too: code loaded into this exe as admin; the
    // page says so under the switch, see NetConfigClean), then clears what its environment could slip in the same way
    // (the profiler and the COMPLUS_ settings that load code, named one by one: FOR /F would start a cmd.exe that runs
    // the user's AutoRun; the switch that would make cmd look for it on the PATH; compatibility shims), and starts it
    // from its own folder (no quotes in cmd's line: conhost passes it on re-quoted, which drops every inner pair).
    // conhost --headless: no window, where cmd.exe alone shows one. The account may start it and read it, never change
    // it (MakeTask). Still the account's own: code of its that wins a race (the setting put back between cmd's look
    // and .NET's) gets in, as it could into any program it starts as admin
    public static string TaskXml(string sid, string dir)
    {
        string sys = Environment.GetFolderPath(Environment.SpecialFolder.System), x = System.Security.SecurityElement.Escape(Brand.Name);
        string args = "--headless " + Path.Combine(sys, "cmd.exe") + " /d /e:on /v:off /s /c \"" + Path.Combine(sys, "reg.exe") + " query HKCU\\Software\\Microsoft\\.NETFramework /s 2>nul | " +
            Path.Combine(sys, "findstr.exe") + " REG_ >nul && exit /b 11 & set COR_ENABLE_PROFILING=&set COR_PROFILER=&set COR_PROFILER_PATH=&set COR_PROFILER_PATH_32=&set COR_PROFILER_PATH_64=" +
            "&set COMPLUS_Version=&set COMPLUS_InstallRoot=&set COMPLUS_DefaultVersion=&set COMPLUS_ProfAPI_ProfilerCompatibilitySetting=&set COMPLUS_AltJit=&set COMPLUS_AltJitName=" +
            "&set COMPLUS_AltJitNgen=&set COMPLUS_JitName=&set COMPLUS_GCName=&set APPDOMAIN_MANAGER_ASM=&set APPDOMAIN_MANAGER_TYPE=&set NoDefaultCurrentDirectoryInExePath=&set __COMPAT_LAYER=" +
            "&cd /d " + dir + "&&.\\" + Path.GetFileName(Application.ExecutablePath) + " --hwinfo-task\"";
        return "<Task version=\"1.2\" xmlns=\"http://schemas.microsoft.com/windows/2004/02/mit/task\">" +
            "<RegistrationInfo><Author>" + x + "</Author><Description>" + System.Security.SecurityElement.Escape("Restarts HWiNFO once it has run about 11 hours, with its shared memory on, so the free version never stops sharing, " +
                "and at once when " + Brand.Name + "'s Restart HWiNFO asks. Turn the restarts off in " + Brand.Name + "'s Settings (Keep HWiNFO sharing). Task version " + TaskVersion + ". " + TaskMark) + "</Description></RegistrationInfo>" +
            "<Triggers><TimeTrigger><StartBoundary>" + DateTime.Now.AddMinutes(1).ToString("yyyy-MM-dd'T'HH:mm:ss", System.Globalization.CultureInfo.InvariantCulture) + "</StartBoundary><Repetition><Interval>PT5M</Interval></Repetition></TimeTrigger></Triggers>" +
            "<Principals><Principal id=\"Author\"><UserId>" + sid + "</UserId><LogonType>InteractiveToken</LogonType><RunLevel>HighestAvailable</RunLevel></Principal></Principals>" +
            "<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>" +
            "<StartWhenAvailable>true</StartWhenAvailable><IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings><ExecutionTimeLimit>PT10M</ExecutionTimeLimit>" +
            "<Priority>4</Priority></Settings>" +   // (the default, 7, would start HWiNFO below normal priority)
            "<Actions Context=\"Author\"><Exec><Command>" + Path.Combine(sys, "conhost.exe") + "</Command><Arguments>" + System.Security.SecurityElement.Escape(args) + "</Arguments></Exec></Actions></Task>";
    }
    static object Tasks() { var s = Activator.CreateInstance(Type.GetTypeFromProgID("Schedule.Service")); Com(s, "Connect", Call); return s; }
    // the task's account as a SID (null: no task, "": none named)
    static string Owner(object folder)
    {
        string u;
        try { u = Com(Com(Com(Com(folder, "GetTask", Call, TaskName), "Definition", Get), "Principal", Get), "UserId", Get) as string; }
        catch { return null; }
        if (string.IsNullOrEmpty(u)) return "";
        try { return new System.Security.Principal.NTAccount(u).Translate(typeof(System.Security.Principal.SecurityIdentifier)).Value; } catch { }
        try { return new System.Security.Principal.SecurityIdentifier(u).Value; } catch { return u; }
    }
    static bool Alive(string sid)
    {
        try { new System.Security.Principal.SecurityIdentifier(sid).Translate(typeof(System.Security.Principal.NTAccount)); return true; }
        catch { return false; }
    }
    // made (or made again: a newer TaskXml, this copy's folder): 0; 9 another account's is there (one task for the whole
    // PC, left alone while that account exists). One already there is deleted first, so nothing of it stays (its owner,
    // its rights). Owned by the admins; the account may start it and read it, not change it
    static int MakeTask(System.Security.Principal.SecurityIdentifier who, string dir)
    {
        object s = Tasks();
        try
        {
            object f = Com(s, "GetFolder", Call, "\\");
            string o = Owner(f);
            if (!string.IsNullOrEmpty(o) && o != who.Value && Alive(o)) return 9;
            if (o != null) Com(f, "DeleteTask", Call, TaskName, 0);
            Com(f, "RegisterTask", Call, TaskName, TaskXml(who.Value, dir), 6 /*create or update*/, null, null, 3 /*interactive token*/, "O:BAG:SYD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;GRGX;;;" + who.Value + ")");
            Forget();
            return 0;
        }
        finally { Marshal.ReleaseComObject(s); }
    }
    // 0 deleted (or none), 9 another account's (left alone; who null: the uninstall, any), 1 still there
    static int DeleteTask(System.Security.Principal.SecurityIdentifier who)
    {
        object s = Tasks();
        try
        {
            object f = Com(s, "GetFolder", Call, "\\");
            string o = Owner(f);
            if (o != null && who != null && o.Length > 0 && o != who.Value && Alive(o)) return 9;
            if (o != null) try { Com(Com(f, "GetTask", Call, TaskName), "Stop", Call, 0); } catch { }   // (a run under way first: it holds this exe)
            if (o != null) try { Com(f, "DeleteTask", Call, TaskName, 0); } catch { }
            Forget();
            return Owner(f) == null ? 0 : 1;
        }
        finally { Marshal.ReleaseComObject(s); }
    }
    // an older task's script (version 5 and before) and the last result, next to it in HKLM
    static void Forget()
    {
        try
        {
            using (var b = Lm())
            {
                using (var k = b.OpenSubKey(Key + @"\Keep", true))
                {
                    if (k == null) return;
                    k.DeleteValue(TaskName, false); k.DeleteValue(TaskName + " result", false);
                    if (k.ValueCount + k.SubKeyCount > 0) return;
                }
                b.DeleteSubKey(Key + @"\Keep", false);
            }
        }
        catch { }
    }
    // Restart HWiNFO's start of the task, from the page's account (it may, see MakeTask): one already running takes the ask
    public static bool StartTask()
    {
        object s = null;
        try
        {
            s = Tasks();
            object t = Com(Com(s, "GetFolder", Call, "\\"), "GetTask", Call, TaskName);
            try { Com(t, "Run", Call, (object)null); return true; }
            catch { return 4.Equals(Com(t, "State", Get)); }   // (4: running)
        }
        catch { return false; }
        finally { if (s != null) try { Marshal.ReleaseComObject(s); } catch { } }
    }

    // no settings for .NET programs in this account's registry (HKCU\Software\Microsoft\.NETFramework, any value at any
    // depth): with one, the task's cmd.exe doesn't start this exe as admin (see TaskXml)
    public static bool NetConfigClean()
    {
        try { using (var k = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\.NETFramework")) return k == null || !AnyValue(k, 0); }
        catch { return false; }
    }
    static bool AnyValue(Microsoft.Win32.RegistryKey k, int depth)
    {
        if (k.ValueCount > 0) return true;
        if (depth > 8) return false;
        foreach (var n in k.GetSubKeyNames())
            using (var sub = k.OpenSubKey(n)) if (sub != null && AnyValue(sub, depth + 1)) return true;
        return false;
    }

    // ---- this account's own (HKCU): Keep HWiNFO sharing turned off, and Restart HWiNFO's ask and its answer ----
    public static bool KeepOff()
    {
        try { using (var k = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(Key)) return k != null && 1.Equals(k.GetValue("KeepOff")); }
        catch { return false; }
    }
    public static void SetKeepOff(bool off)
    {
        using (var k = Microsoft.Win32.Registry.CurrentUser.CreateSubKey(Key))
        {
            if (off) k.SetValue("KeepOff", 1, Microsoft.Win32.RegistryValueKind.DWord); else k.DeleteValue("KeepOff", false);
        }
    }
    // an admin's account with HW Deck not running as admin, where "as admin" gives this same account its admin rights at
    // one Windows prompt (a Yes or a No, no password): the limited token (TokenElevationType 3) whose linked token is this
    // account's own and is in Administrators. Not a split token of another kind (Backup Operators: its other half is no
    // admin), and not where Windows gives admin rights through an account of its own (Windows 11's Administrator
    // protection: what is started as admin there runs as that other account, with its own registry and folders)
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(IntPtr token, int cls, out int info, int len, out int ret);
    [DllImport("advapi32.dll", SetLastError = true, EntryPoint = "GetTokenInformation")] static extern bool GetLinkedToken(IntPtr token, int cls, out IntPtr info, int len, out int ret);
    public static bool LimitedAdmin()
    {
        try
        {
            using (var me = System.Security.Principal.WindowsIdentity.GetCurrent())
            {
                int t, n; IntPtr linked;
                if (!GetTokenInformation(me.Token, 18, out t, 4, out n) || t != 3) return false;
                if (!GetLinkedToken(me.Token, 19, out linked, IntPtr.Size, out n) || linked == IntPtr.Zero) return false;
                try
                {
                    using (var full = new System.Security.Principal.WindowsIdentity(linked))
                        return full.User != null && full.User.Equals(me.User) && new System.Security.Principal.WindowsPrincipal(full).IsInRole(System.Security.Principal.WindowsBuiltInRole.Administrator);
                }
                finally { CloseHandle(linked); }
            }
        }
        catch { return false; }
    }
    // Update now's note for the copy the installer starts when it is done: the version the update started from (null: none)
    public static void SetUpdateFrom(string v)
    {
        try { using (var k = Microsoft.Win32.Registry.CurrentUser.CreateSubKey(Key)) { if (v != null) k.SetValue("UpdateFrom", v); else k.DeleteValue("UpdateFrom", false); } }
        catch { }
    }
    public static string TakeUpdateFrom()
    {
        try
        {
            using (var k = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(Key, true))
            {
                string v = k != null ? k.GetValue("UpdateFrom") as string : null;
                if (v != null) k.DeleteValue("UpdateFrom", false);
                return v;
            }
        }
        catch { return null; }
    }
    static long Stamp(string s)
    {
        long t; return long.TryParse(s ?? "", System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out t) ? t : 0;
    }
    // the ask (its time, unix ms) when it is new: not answered yet, from the last 2 minutes; 0: none
    static long Asked()
    {
        try
        {
            using (var k = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(Key))
            {
                if (k == null) return 0;
                long t = Stamp(k.GetValue("RestartAsked") as string), done = Stamp(((k.GetValue("RestartDone") as string) ?? "").Split(':')[0]);
                long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                return t > done && now - t < 120000 && t - now < 5000 ? t : 0;
            }
        }
        catch { return 0; }
    }
    static void Answer(long t, int code)
    {
        try { using (var k = Microsoft.Win32.Registry.CurrentUser.CreateSubKey(Key)) k.SetValue("RestartDone", t.ToString(System.Globalization.CultureInfo.InvariantCulture) + ":" + code.ToString(System.Globalization.CultureInfo.InvariantCulture)); }
        catch { }
    }
    public static bool Answered(long t, out int code)
    {
        code = 0;
        try
        {
            using (var k = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(Key))
            {
                var p = ((k != null ? k.GetValue("RestartDone") as string : null) ?? "").Split(':');
                return p.Length == 2 && Stamp(p[0]) == t && int.TryParse(p[1], System.Globalization.NumberStyles.AllowLeadingSign, System.Globalization.CultureInfo.InvariantCulture, out code);
            }
        }
        catch { return false; }
    }

    // ---- the task's run: a look (Look), then Restart HWiNFO's ask when there is one (each answered by a restart of
    // its own, one that came in meanwhile too). One run at a time: another one (Restart HWiNFO's start while this one
    // works) leaves at once, and this one takes the ask. Exit codes: Restart's, 7 no admin rights ----
    static int HwinfoTask()
    {
        using (var mu = new System.Threading.Mutex(false, @"Local\HWDeck hwinfo task " + Brand.Name))
        {
            bool mine = true;
            try { mine = mu.WaitOne(0); } catch (System.Threading.AbandonedMutexException) { }
            if (!mine) return 0;
            try
            {
                bool admin = new System.Security.Principal.WindowsPrincipal(System.Security.Principal.WindowsIdentity.GetCurrent()).IsInRole(System.Security.Principal.WindowsBuiltInRole.Administrator);
                if (Brand.Name.EndsWith(" Test", StringComparison.Ordinal))   // (a test build: that it ran, how, and from where)
                    try { using (var k = Microsoft.Win32.Registry.CurrentUser.CreateSubKey(Key)) k.SetValue("TestRan", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + " admin=" + admin + " dir=" + Environment.CurrentDirectory + " cor=" + (Environment.GetEnvironmentVariable("COR_ENABLE_PROFILING") ?? "(none)")); } catch { }
                long asked = Asked();
                int code = asked != 0 ? 0 : Look(admin);
                if (asked == 0) asked = Asked();
                for (int i = 0; asked != 0 && i < 5; i++)
                {
                    try { code = admin ? Restart(null, true) : 7; } catch { code = 1; }
                    Answer(asked, code);
                    asked = Asked();
                }
                return code;
            }
            finally { try { mu.ReleaseMutex(); } catch { } }
        }
    }
    // every 5 minutes: once HWiNFO (where its installer puts it, in this Windows session) has run 10 h 50 min, so always
    // before the free version's 12 h, it is restarted in a quiet moment: nothing full screen in front (a game, a video)
    // and 2 minutes without a key or the mouse touched (HWiNFO takes the focus for a moment as it starts); from 11 h 40
    // min on, anyway. A closed HWiNFO stays closed; Keep HWiNFO sharing off: nothing. Over in a moment, so nothing holds
    // this exe for long (an update replaces it)
    static int Look(bool admin)
    {
        if (!admin) return Leave(7);   // (this account isn't an admin anymore: said under the switch)
        if (KeepOff()) return 0;
        int min = 650, idle = 120, m;
        if (Brand.Name.EndsWith(" Test", StringComparison.Ordinal))   // (a test build: another age and idle time, in minutes and seconds)
        {
            if (int.TryParse(Environment.GetEnvironmentVariable("HWDECK_KEEP_MIN"), out m) && m >= 0) min = m;
            if (int.TryParse(Environment.GetEnvironmentVariable("HWDECK_KEEP_IDLE"), out m) && m >= 0) idle = m;
        }
        var hw = Hwinfos();
        if (hw.Count == 0) return 0;
        var p = hw[0];
        double age;
        try { age = (DateTime.UtcNow - p.StartTime.ToUniversalTime()).TotalMinutes; } catch { return 0; }
        if (age < min) return 0;
        string exe = Image(p);
        if (exe == null || !Standard(exe)) return Leave(6);
        if (age < Math.Max(700, min + 50) && !Calm(idle)) return 0;   // (the next look, in 5 minutes)
        return Leave(Restart(exe, true), true);
    }
    // a look's result for the note under the switch (KeepNote): one with nothing to do keeps the last one
    static int Leave(int code, bool restarted = false)
    {
        if (code != 0 || restarted)
            try { using (var b = Lm()) using (var k = b.CreateSubKey(Key + @"\Keep")) k.SetValue(TaskName + " result", code.ToString(System.Globalization.CultureInfo.InvariantCulture)); } catch { }
        return code;
    }
    [DllImport("shell32.dll")] static extern int SHQueryUserNotificationState(out int state);
    [DllImport("user32.dll")] static extern bool GetLastInputInfo(uint[] info);
    // nothing full screen in front (2, 3, 4: a full-screen app, a Direct3D game, presentation mode), nobody at the PC
    static bool Calm(int idle)
    {
        int q = 0;
        try { SHQueryUserNotificationState(out q); } catch { }
        if (q == 2 || q == 3 || q == 4) return false;
        var li = new uint[] { 8, 0 };
        return !GetLastInputInfo(li) || unchecked((uint)Environment.TickCount - li[1]) >= (uint)idle * 1000;
    }
    // the HWiNFOs running in this Windows session, the oldest first
    static List<Process> Hwinfos()
    {
        int ses = Process.GetCurrentProcess().SessionId;
        var l = new List<Process>();
        foreach (var n in new[] { "HWiNFO64", "HWiNFO32" })
            foreach (var p in Process.GetProcessesByName(n))
                try { if (p.SessionId == ses) { var t = p.StartTime; l.Add(p); } } catch { }
        return l.OrderBy(x => x.StartTime).ToList();
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageNameW(IntPtr h, int flags, StringBuilder name, ref int size);
    static string Image(Process p)
    {
        try { var sb = new StringBuilder(1024); int n = sb.Capacity; return QueryFullProcessImageNameW(p.Handle, 0, sb, ref n) ? sb.ToString(0, n) : null; }
        catch { return null; }
    }
    // where HWiNFO's installer puts it (Program Files from Windows, the known folder: never from the environment). The
    // only HWiNFO started as admin with nobody asked: any other folder, under Program Files too, may be one anyone can
    // write to, and bring someone else's files along
    static IEnumerable<string> StandardPaths()
    {
        string a = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), b = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
        if (a.Length > 0) yield return Path.Combine(a, @"HWiNFO64\HWiNFO64.EXE");
        if (b.Length > 0) yield return Path.Combine(b, @"HWiNFO32\HWiNFO32.EXE");
        if (a.Length > 0) yield return Path.Combine(a, @"HWiNFO32\HWiNFO32.EXE");
    }
    public static bool Standard(string exe)
    {
        try { string f = Path.GetFullPath(exe); return StandardPaths().Any(x => string.Equals(x, f, StringComparison.OrdinalIgnoreCase)); }
        catch { return false; }
    }
    public static string FindHwinfo() { return StandardPaths().FirstOrDefault(File.Exists); }

    // ---- a restart: kills HWiNFO, switches its shared memory back on in its INI (the free version writes SensorsSM=0
    // after 12 h) and starts it again. 0 done, 1 it wouldn't start, 2 the INI couldn't be written, 3 no HWiNFO, 4 not
    // signed by its maker (REALiX), 6 (silent: the task's, with no prompt) that HWiNFO isn't where its installer puts it
    // (see StandardPaths). The exe is held from its check until it has started: nothing can swap it in between. Every
    // restart comes back in the tray and never bothers anyone: the INI also gets its welcome screen off, Sensors-only,
    // started minimized, and its close button minimizing (to the tray); then, until it shares (its own poll time: another
    // program can keep the old map open) and 5 s more, 25 s at most, a Sensors window that shows anyway is closed into
    // the tray, and the window in front as it starts gets the focus back (HWiNFO takes it, with all its windows hidden;
    // a hung window is left alone). Windows refuses SetForegroundWindow from the background (and flashes the taskbar
    // button), so this joins HWiNFO's input and that window's and brings it to the top. Never a minimize: on a window in
    // the tray it shows it, minimized on the taskbar. HWiNFO only from this Windows session ----
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindowExW(IntPtr parent, IntPtr after, string cls, string title);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsHungAppWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool PostMessageW(IntPtr h, uint msg, IntPtr w, IntPtr l);
    static int Restart(string exe, bool silent)
    {
        if (exe != null && (!Regex.IsMatch(Path.GetFileName(exe), @"^HWiNFO(64|32)\.exe$", RegexOptions.IgnoreCase) || !File.Exists(exe))) exe = null;
        if (exe == null && silent) { var hw = Hwinfos(); if (hw.Count > 0) exe = Image(hw[0]); }   // (the one running)
        if (exe == null) exe = FindHwinfo();
        if (exe == null) return 3;
        if (silent && !Standard(exe)) return 6;
        FileStream hold;
        try { hold = new FileStream(exe, FileMode.Open, FileAccess.Read, FileShare.Read); } catch { return 1; }
        using (hold) return Restart(exe, hold);
    }
    static int Restart(string exe, FileStream hold)
    {
        if (!ByRealix(exe)) return 4;
        int ses = Process.GetCurrentProcess().SessionId;
        foreach (var n in new[] { "HWiNFO64", "HWiNFO32" })
            foreach (var p in Process.GetProcessesByName(n))
                try { if (p.SessionId == ses) p.Kill(); } catch { }
        System.Threading.Thread.Sleep(3000);
        int code = 0;
        try { Ini(Path.ChangeExtension(exe, ".INI")); } catch { code = 2; }
        if (!ByRealix(exe)) return 4;   // (again: the file could have changed meanwhile)
        IntPtr front = GetForegroundWindow();
        long st0 = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        int np;
        try { np = Launch(exe); } catch (Exception ex) { T("restart: HWiNFO wouldn't start: " + ex.Message); return 1; }
        try
        {
            DateTime t0 = DateTime.UtcNow, up = DateTime.MinValue;
            while ((DateTime.UtcNow - t0).TotalSeconds < 25 && !(up != DateTime.MinValue && (DateTime.UtcNow - up).TotalSeconds > 5))
            {
                System.Threading.Thread.Sleep(200);
                if (np == 0) { var hw = Hwinfos(); if (hw.Count > 0) np = hw[hw.Count - 1].Id; }   // (Windows named none: the newest one)
                if (up == DateTime.MinValue)
                    try
                    {
                        using (var mm = MemoryMappedFile.OpenExisting(@"Global\HWiNFO_SENS_SM2", MemoryMappedFileRights.Read))
                        using (var va = mm.CreateViewAccessor(0, 20, MemoryMappedFileAccess.Read))
                            if (va.ReadUInt32(0) == 0x53695748 && va.ReadInt64(12) >= st0) up = DateTime.UtcNow;
                    }
                    catch { }
                IntPtr h = IntPtr.Zero;
                while (code == 0 && (h = FindWindowExW(IntPtr.Zero, h, "#32770", null)) != IntPtr.Zero)
                {
                    uint q; GetWindowThreadProcessId(h, out q);
                    if (np != 0 && q == (uint)np && IsWindowVisible(h))
                    {
                        var t = new StringBuilder(256); GetWindowTextW(h, t, 256);
                        if (t.ToString().IndexOf("Sensors", StringComparison.OrdinalIgnoreCase) >= 0) PostMessageW(h, 0x112, (IntPtr)0xF060, IntPtr.Zero);   // SC_CLOSE: into the tray
                    }
                }
                uint fq; uint ft = GetWindowThreadProcessId(GetForegroundWindow(), out fq);
                if (np != 0 && fq == (uint)np && front != IntPtr.Zero && IsWindow(front) && !IsHungAppWindow(front))
                {
                    uint tq; uint tt = GetWindowThreadProcessId(front, out tq), me = GetCurrentThreadId();
                    bool a = AttachThreadInput(me, ft, true), b = AttachThreadInput(ft, tt, true);
                    BringWindowToTop(front);
                    if (b) AttachThreadInput(ft, tt, false);
                    if (a) AttachThreadInput(me, ft, false);
                }
            }
        }
        catch { }
        if (Hwinfos().Count == 0) return 1;   // (it started and left again)
        return code;
    }
    // HWiNFO's manifest asks for uiAccess, and CreateProcess refuses such a program (error 740) from an admin process
    // too: only Windows' own launcher starts it, which the shell reaches. So through the shell, but with the machine's
    // own class for programs (HKLM's exefile): never this account's file associations (HKCU\Software\Classes), which
    // its programs can change. No window of the shell's own, and done before this returns (no message loop here).
    // Its process id (0: Windows named none); throws when it wouldn't start
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct ShellExec
    {
        public int Size; public uint Mask; public IntPtr Hwnd;
        public string Verb, File, Parameters, Directory;
        public int Show; public IntPtr InstApp, IdList;
        public string Class; public IntPtr ClassKey; public uint HotKey; public IntPtr Icon, Process;
    }
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool ShellExecuteExW(ref ShellExec info);
    [DllImport("kernel32.dll")] static extern int GetProcessId(IntPtr h);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    static int Launch(string exe)
    {
        using (var b = Lm()) using (var k = b.OpenSubKey(@"SOFTWARE\Classes\exefile"))
        {
            if (k == null) throw new InvalidOperationException("no exefile class");
            // (0x40 its process handle back, 0x3 the class key given, 0x400 no error boxes, 0x100 finished before it returns)
            var i = new ShellExec { Mask = 0x40 | 0x3 | 0x400 | 0x100, File = exe, Directory = Path.GetDirectoryName(exe), Show = 1, ClassKey = k.Handle.DangerousGetHandle() };
            i.Size = Marshal.SizeOf(typeof(ShellExec));
            if (!ShellExecuteExW(ref i)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            if (i.Process == IntPtr.Zero) return 0;
            try { return GetProcessId(i.Process); } finally { CloseHandle(i.Process); }
        }
    }
    // HWiNFO's INI, as HWiNFO keeps it (the system's ANSI code page): each setting replaced where it is, else put under
    // [Settings] (made at the end when there is none)
    static void Ini(string ini)
    {
        var lines = File.Exists(ini) ? File.ReadAllLines(ini, Encoding.Default).ToList() : new List<string>();
        foreach (var kv in new[] { "SensorsSM=1", "ShowWelcomeAndProgress=0", "SensorsOnly=1", "MinimalizeMainWnd=1", "MinimalizeSensors=1", "MinimalizeSensorsClose=1" })
        {
            var re = new Regex("^" + kv.Substring(0, kv.IndexOf('=') + 1), RegexOptions.IgnoreCase);
            if (lines.Any(l => re.IsMatch(l))) lines = lines.Select(l => re.IsMatch(l) ? kv : l).ToList();
            else if (lines.Any(l => l.Trim().Equals("[Settings]", StringComparison.OrdinalIgnoreCase)))
            {
                var o = new List<string>();
                foreach (var l in lines) { o.Add(l); if (l.Trim().Equals("[Settings]", StringComparison.OrdinalIgnoreCase)) o.Add(kv); }
                lines = o;
            }
            else { lines.Add("[Settings]"); lines.Add(kv); }
        }
        File.WriteAllLines(ini, lines, Encoding.Default);
    }
    // signed by HWiNFO's maker, and Windows' own check of the signature passes (as PowerShell's "Valid" did)
    [StructLayout(LayoutKind.Sequential)] struct TrustFile { public int Size; public IntPtr Path, File, Subject; }
    [StructLayout(LayoutKind.Sequential)] struct TrustData { public int Size; public IntPtr Policy, Sip; public int Ui, Revocation, Choice; public IntPtr Info; public int StateAction; public IntPtr State, Url; public int ProvFlags, UiContext; public IntPtr Settings; }
    [DllImport("wintrust.dll")] static extern int WinVerifyTrust(IntPtr hwnd, ref Guid action, IntPtr data);
    public static bool ByRealix(string file)
    {
        IntPtr p = IntPtr.Zero, f = IntPtr.Zero, d = IntPtr.Zero;
        try
        {
            p = Marshal.StringToHGlobalUni(file);
            var tf = new TrustFile { Size = Marshal.SizeOf(typeof(TrustFile)), Path = p };
            f = Marshal.AllocHGlobal(tf.Size); Marshal.StructureToPtr(tf, f, false);
            // no UI, no revocation check, one file, checked and done in one call
            var td = new TrustData { Size = Marshal.SizeOf(typeof(TrustData)), Ui = 2, Revocation = 0, Choice = 1, Info = f, StateAction = 0 };
            d = Marshal.AllocHGlobal(td.Size); Marshal.StructureToPtr(td, d, false);
            var g = new Guid("00AAC56B-CD44-11d0-8CC2-00C04FC295EE");   // WINTRUST_ACTION_GENERIC_VERIFY_V2
            if (WinVerifyTrust(new IntPtr(-1), ref g, d) != 0) return false;
            var c = new System.Security.Cryptography.X509Certificates.X509Certificate2(System.Security.Cryptography.X509Certificates.X509Certificate.CreateFromSignedFile(file));
            if (!Regex.IsMatch(c.Subject, "^CN=\"?REALiX, s\\.r\\.o\\.\"?,")) return false;
            // (and its chain ends in a root the whole PC trusts: one put in this account's own store, which its programs
            // can do, doesn't count. An expired certificate is fine: the signature has its time stamp)
            var ch = new System.Security.Cryptography.X509Certificates.X509Chain(true);
            ch.ChainPolicy.RevocationMode = System.Security.Cryptography.X509Certificates.X509RevocationMode.NoCheck;
            ch.ChainPolicy.VerificationFlags = System.Security.Cryptography.X509Certificates.X509VerificationFlags.IgnoreNotTimeValid | System.Security.Cryptography.X509Certificates.X509VerificationFlags.IgnoreCtlNotTimeValid;
            try { return ch.Build(c); } finally { ch.Reset(); }
        }
        catch { return false; }
        finally
        {
            if (d != IntPtr.Zero) Marshal.FreeHGlobal(d);
            if (f != IntPtr.Zero) Marshal.FreeHGlobal(f);
            if (p != IntPtr.Zero) Marshal.FreeHGlobal(p);
        }
    }
}

static class Program
{
    [STAThread]
    static void Main(string[] args)
    {
        // the admin work and the installer's (see Elevated): before anything else, with no window and no single-instance lock
        if (args.Length > 0 && Elevated.IsVerb(args[0])) { Environment.ExitCode = Elevated.Run(args); return; }
        string data = Brand.DataDir ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), Brand.Name);
        int fake = 0; bool min = false, custom = false, after = false;
        string appDir = AppDomain.CurrentDomain.BaseDirectory;
        if (new[] { @"web\index.html", @"web\deck.js", @"web\deck.css", "Microsoft.Web.WebView2.WinForms.dll", "Microsoft.Web.WebView2.Core.dll", "WebView2Loader.dll" }.Any(f => !File.Exists(Path.Combine(appDir, f))))
        {
            MessageBox.Show(Brand.Name + " is missing some of its files" + (Brand.Updates ? ". Install it again (or Repair it in Settings, Apps), then start it from the Start menu." : " (web\\ and the WebView2 files belong next to " + Path.GetFileName(Application.ExecutablePath) + ")."), Brand.Name, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }
        for (int i = 0; i < args.Length; i++)
        {
            string a = args[i].ToLowerInvariant();
            if (a == "-min" || a == "--min" || a == "/min") min = true;
            else if (a == "--data")
            {
                string d = i + 1 < args.Length ? args[++i] : null;
                try
                {
                    if (string.IsNullOrWhiteSpace(d) || d.StartsWith("-")) throw new ArgumentException("--data needs a folder after it");
                    data = Path.GetFullPath(d.Trim().Trim('"'));
                    if (data.Length > 3) data = data.TrimEnd('\\');   // "X\" and "X" are one folder (and one running copy)
                    Directory.CreateDirectory(data); custom = true;
                }
                catch (Exception ex) { MessageBox.Show(Brand.Name + " can't use that data folder:\n\n" + (d ?? "") + "\n" + ex.Message, Brand.Name, MessageBoxButtons.OK, MessageBoxIcon.Warning); return; }
            }
            else if (a == "--after" && i + 1 < args.Length)
            {
                after = true;
                int pid; if (int.TryParse(args[++i], out pid)) try { using (var old = Process.GetProcessById(pid)) old.WaitForExit(20000); } catch { }   // a restart: let the old copy finish saving
            }
            else if (a == "--after-browser" && i + 1 < args.Length)
            {
                // (and its page's browser: a new page would join one still closing; only a WebView2 browser, that pid may be reused)
                int pid; if (int.TryParse(args[++i], out pid)) try { using (var old = Process.GetProcessById(pid)) if (old.ProcessName.Equals("msedgewebview2", StringComparison.OrdinalIgnoreCase)) old.WaitForExit(10000); } catch { }
            }
            else if (a == "--fake") { fake = 300; int n; if (i + 1 < args.Length && int.TryParse(args[i + 1], out n)) { fake = Math.Max(1, Math.Min(20000, n)); i++; } }
            else if (a == "--updated" && i + 1 < args.Length) { int c; if (int.TryParse(args[++i], out c)) DeckForm.UpdateResult = c; }   // (Update now's script, see UpdateNow)
            else if (a == "--relaunch" && i + 1 < args.Length) { int c; if (int.TryParse(args[++i], out c)) DeckForm.Relaunches = c; }   // (how many times in a row the page's browser died)
            // (11-17 test batch 1001: a TEST copy on a made-up HWiNFO block, fakehw.exe, named by HWDECK_HWMAP; it changes
            // nothing on the PC. No real start passes it)
            else if (a == "--hwtest") { string mn = Environment.GetEnvironmentVariable("HWDECK_HWMAP"); if (!string.IsNullOrEmpty(mn)) HwSource.MapName = mn; Brand.NoActions = true; DeckForm.OtherArgs.Add(args[i]); }
            else DeckForm.OtherArgs.Add(args[i]);   // (a build's own, like HW Dashboard's --test: kept for a restart)
        }
        // made-up values never go into the real history and logs: a demo without --data gets its own folder
        if (fake > 0 && !custom) data = Path.Combine(data, "demo");
        bool created;
        // one instance per data folder (a test run with --data can sit next to the real one); starting it again
        // brings the running one forward instead of doing nothing
        ulong h = 14695981039346656037UL;
        foreach (char c in data.ToLowerInvariant()) { h ^= c; h *= 1099511628211UL; }
        string id = h.ToString("x16");
        System.Threading.Mutex mu;
        try { mu = new System.Threading.Mutex(true, "HWDeck-" + id, out created); }
        catch (UnauthorizedAccessException)
        {
            // the copy running on this data folder runs as admin: this one can't even look at it
            if (!min) MessageBox.Show(Brand.Name + " is already running as administrator. Quit it from its tray icon first, then start it again.", Brand.Name, MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }
        // a restart whose old copy is still letting go: wait for it instead of quitting (and leaving no HW Deck at all)
        if (!created && after) try { created = mu.WaitOne(30000); } catch (System.Threading.AbandonedMutexException) { created = true; }
        if (!created)
        {
            // the running copy shows its window (unless this launch asked for the tray, -min); this launch passes on its right to bring a window to the front
            // a running copy answers (HWDeck-shown-); one that was quitting just then doesn't, and lets go in a moment:
            // this launch then starts after all, instead of leaving none. (An answer left from an earlier launch that gave
            // up is cleared first.)
            bool asked = false;
            System.Threading.EventWaitHandle ack = null;
            try { System.Threading.EventWaitHandle.TryOpenExisting("HWDeck-shown-" + id, out ack); if (ack != null) ack.Reset(); } catch { }
            try { System.Threading.EventWaitHandle ev; if (!min && System.Threading.EventWaitHandle.TryOpenExisting("HWDeck-show-" + id, out ev)) { AllowSetForegroundWindow(-1); ev.Set(); ev.Dispose(); asked = true; } } catch { }
            if (asked)
            {
                bool answered = false;
                try { answered = ack != null && ack.WaitOne(3000); } catch { }
                if (!answered) try { created = mu.WaitOne(10000); } catch (System.Threading.AbandonedMutexException) { created = true; }
            }
            if (!created) return;
        }
        if (fake == 0 && !custom) DeckForm.UpdateMarker();   // (the copy that runs: a launch that only brought the running one forward left the note)
        var show = new System.Threading.EventWaitHandle(false, System.Threading.EventResetMode.AutoReset, "HWDeck-show-" + id);
        var shown = new System.Threading.EventWaitHandle(false, System.Threading.EventResetMode.AutoReset, "HWDeck-shown-" + id);
        Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
        Application.ThreadException += delegate(object s, System.Threading.ThreadExceptionEventArgs e) { Crash(data, e.Exception); };
        AppDomain.CurrentDomain.UnhandledException += delegate(object s, UnhandledExceptionEventArgs e) { Crash(data, e.ExceptionObject as Exception); };
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        DeckForm form;
        try { form = new DeckForm(min, data, custom || fake > 0, fake); }
        catch (Exception ex)
        {
            Crash(data, ex);
            MessageBox.Show(Brand.Name + " couldn't start:\n\n" + ex.Message, Brand.Name, MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }
        // the flag first, then the handle: a window made in between still sees the flag (HandleCreated shows it)
        System.Threading.ThreadPool.RegisterWaitForSingleObject(show, delegate { if (form.Quitting) return; shown.Set(); form.showAsked = true; if (form.IsHandleCreated) { try { form.BeginInvoke((Action)form.ShowWin); } catch { } } }, null, -1, false);
        System.Threading.ThreadPool.QueueUserWorkItem(delegate { DeckForm.UpdateLeftovers(); });
        Application.Run(form);
        GC.KeepAlive(mu); GC.KeepAlive(show); GC.KeepAlive(shown);
    }
    [DllImport("user32.dll")] static extern bool AllowSetForegroundWindow(int pid);
    // an error nothing else caught: into app.log instead of the .NET error dialog
    static void Crash(string dir, Exception ex)
    {
        try { File.AppendAllText(Path.Combine(dir, "app.log"), AppInfo.Stamp() + "  unhandled: " + ex + "\r\n"); } catch { }
    }
}

// ==== headset begin ====
// ==== the headset (11-13, moved from HW Dashboard into HW Deck: his friend has the same headset) ====
// A SteelSeries Arctis Nova Pro Wireless base station (USB 1038:12E0) and a Logitech LIGHTSPEED mouse (046D:C54D), read
// by HW Deck itself with no SteelSeries or Logitech software: the batteries as HW Deck's own readings (in its list only
// once the device was found), and the base station's small OLED screen showing a page built in the Headset cell's
// popup (off until switched on there). Batt: the devices; HsPage: the saved pages and the popup's messages; Hs, Cv,
// Fnt, Geo, Ico and the HsAnim classes: the renderer and the start up / shut down animations. Its own namespace: its
// usings (threads, Windows' power and session events) stay out of the rest of this file.
namespace HwHeadset
{
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32;
using Microsoft.Win32.SafeHandles;

// The headset base station's page and its start / shut down animations (11-12). The page is his own, built in the
// Headset screen popup: a grid of pieces (the clock, or a reading as a number, bar, ring, knob or graph), drawn with our
// own pixel fonts (no GDI+ text: his "42 46 48" bug, digits run together, can't come back). Made in the "Headset base
// screen redesign" session (hwdeck\local\hs-redesign-1112: pix.cs, class G of designs.cs, layout.cs, anim.cs and the
// eight anim-<key>.cs, checked there by check2.cs and anim-run.cs) and copied here as they are, St renamed HsSt
// (app.cs has its own) and a reading's unit taken from the dashboard. x-hspage.cs keeps his page and asks Hs.Draw;
// x-batt.cs plays the animations.

// pix.cs: shared drawing for the headset screen mock designs (hs-redesign-1112). Pure pixels, no GDI+ text: our own
// pixel fonts, so every character is its own bitmap with at least one empty column before the next.

// the page's 126 x 62 box on the 128 x 64 screen, moved by the burn-in shift (Dx, Dy)
class Cv
{
    public const int W = 126, H = 62;
    public readonly bool[,] Px = new bool[128, 64];
    public readonly int Ox, Oy;
    public int Tone;        // 0 solid, 1 half (every other pixel: looks dimmer on the OLED)
    public bool Hush;       // (11-15) nothing drawn: a part hidden for its blink, its room kept
    public int Outside; public static int Spill;   // pixels a design asked for outside its box (the check counts them)
    public Cv(int dx, int dy) { Ox = dx; Oy = dy; }
    public int Cx0 = 0, Cy0 = 0, Cx1 = W - 1, Cy1 = H - 1, Clipped;   // a piece's own box: pixels past it are counted, not drawn
    public void ClipTo(int x, int y, int w, int h) { Cx0 = x; Cy0 = y; Cx1 = x + w - 1; Cy1 = y + h - 1; }
    public void NoClip() { Cx0 = 0; Cy0 = 0; Cx1 = W - 1; Cy1 = H - 1; }

    public void Set(int x, int y)
    {
        if (x < 0 || y < 0 || x >= W || y >= H) { Outside++; Spill++; return; }
        if (x < Cx0 || y < Cy0 || x > Cx1 || y > Cy1) { Clipped++; return; }
        if (Hush) return;
        if (Tone == 1 && ((x + y) & 1) != 0) return;
        Px[x + Ox, y + Oy] = true;
    }
    public void Off(int x, int y) { if (x >= 0 && y >= 0 && x < W && y < H) Px[x + Ox, y + Oy] = false; }
    // a box turned over, lit for dark (a piece past its yellow or red level, 11-13)
    public void Invert(int x, int y, int w, int h)
    {
        for (int a = Math.Max(0, x); a < Math.Min(W, x + w); a++) for (int b = Math.Max(0, y); b < Math.Min(H, y + h); b++) Px[a + Ox, b + Oy] = !Px[a + Ox, b + Oy];
    }
    public void Block(int x, int y, int w, int h) { for (int a = 0; a < w; a++) for (int b = 0; b < h; b++) Set(x + a, y + b); }
    public void HLine(int x0, int x1, int y) { for (int x = x0; x <= x1; x++) Set(x, y); }
    public void VLine(int x, int y0, int y1) { for (int y = y0; y <= y1; y++) Set(x, y); }
    public void Rect(int x, int y, int w, int h) { HLine(x, x + w - 1, y); HLine(x, x + w - 1, y + h - 1); VLine(x, y + 1, y + h - 2); VLine(x + w - 1, y + 1, y + h - 2); }
    public void HDots(int x0, int x1, int y, int step) { for (int x = x0; x <= x1; x += step) Set(x, y); }
    public void VDots(int x, int y0, int y1, int step) { for (int y = y0; y <= y1; y += step) Set(x, y); }
    public void Bmp(int x, int y, string[] rows) { for (int r = 0; r < rows.Length; r++) for (int c = 0; c < rows[r].Length; c++) if (rows[r][c] == 'X') Set(x + c, y + r); }

    public void Line(int x0, int y0, int x1, int y1, int t)
    {
        int dx = Math.Abs(x1 - x0), sx = x0 < x1 ? 1 : -1, dy = -Math.Abs(y1 - y0), sy = y0 < y1 ? 1 : -1, err = dx + dy;
        while (true)
        {
            Block(x0, y0, t, t);
            if (x0 == x1 && y0 == y1) break;
            int e2 = 2 * err;
            if (e2 >= dy) { err += dy; x0 += sx; }
            if (e2 <= dx) { err += dx; y0 += sy; }
        }
    }

    // angles in degrees, 0 = straight up, clockwise
    public static double Ang(double dx, double dy) { double a = Math.Atan2(dx, -dy) * 180 / Math.PI; return a < 0 ? a + 360 : a; }
    static bool In(double a, double a0, double a1)
    {
        double span = a1 - a0; if (span >= 360) return true; if (span < 0) return false;
        double s = ((a - a0) % 360 + 360) % 360; return s <= span;
    }
    // a thin ring (midpoint circle, one pixel) between two angles; centre on a pixel
    public void Ring(int cx, int cy, int r, double a0, double a1)
    {
        int x = r, y = 0, err = 1 - r;
        var pts = new List<int[]>();
        while (x >= y)
        {
            pts.Add(new[] { x, y }); pts.Add(new[] { y, x }); pts.Add(new[] { -y, x }); pts.Add(new[] { -x, y });
            pts.Add(new[] { -x, -y }); pts.Add(new[] { -y, -x }); pts.Add(new[] { y, -x }); pts.Add(new[] { x, -y });
            y++;
            if (err < 0) err += 2 * y + 1; else { x--; err += 2 * (y - x) + 1; }
        }
        foreach (var p in pts) if (In(Ang(p[0], p[1]), a0, a1)) Set(cx + p[0], cy + p[1]);
    }
    // a thick ring: pixels whose distance from the centre is within t/2 of r
    public void Band(double cx, double cy, double r, double t, double a0, double a1)
    {
        int R = (int)Math.Ceiling(r + t);
        for (int x = (int)Math.Floor(cx - R); x <= cx + R; x++)
            for (int y = (int)Math.Floor(cy - R); y <= cy + R; y++)
            {
                double dx = x - cx, dy = y - cy, d = Math.Sqrt(dx * dx + dy * dy);
                if (d >= r - t + 0.5 && d < r + 0.5 && In(Ang(dx, dy), a0, a1)) Set(x, y);   // (r = the outer edge)
            }
    }
    // dots along a ring, one every step degrees, starting at a0 (+ phase degrees)
    public void RingDots(double cx, double cy, double r, double a0, double a1, double step, double phase, int size)
    {
        for (double a = a0 + phase; a <= a1 + 0.001; a += step)
        {
            double rad = a * Math.PI / 180;
            int x = (int)Math.Round(cx + r * Math.Sin(rad) - (size - 1) / 2.0), y = (int)Math.Round(cy - r * Math.Cos(rad) - (size - 1) / 2.0);
            Block(x, y, size, size);
        }
    }
}

// pixel fonts: each glyph its own bitmap ('X' lit), one empty column (times the scale) between glyphs
class Fnt
{
    readonly Dictionary<char, string[]> g = new Dictionary<char, string[]>();
    public readonly int H, Space;
    Fnt(int h, int space) { H = h; Space = space; }
    void Add(char c, params string[] rows) { g[c] = rows; }

    public int CharW(char c) { string[] r; if (!g.TryGetValue(c, out r)) return Space; int w = 0; foreach (var s in r) w = Math.Max(w, s.Length); return w; }
    public int Width(string s, int k = 1) { int w = 0; for (int i = 0; i < s.Length; i++) w += CharW(s[i]) * k + (i > 0 ? k : 0); return w; }
    // k: scale; dots: each pixel drawn (k-1) x (k-1), a gap around it (an LED board look)
    public int Draw(Cv c, int x, int y, string s, int k = 1, bool dots = false)
    {
        int x0 = x;
        for (int i = 0; i < s.Length; i++)
        {
            if (i > 0) x += k;
            string[] rows;
            if (g.TryGetValue(s[i], out rows))
                for (int r = 0; r < rows.Length; r++)
                    for (int col = 0; col < rows[r].Length; col++)
                        if (rows[r][col] == 'X') { int b = dots ? k - 1 : k; c.Block(x + col * k, y + r * k, b, b); }
            x += CharW(s[i]) * k;
        }
        return x - x0;
    }
    public int Right(Cv c, int right, int y, string s, int k = 1, bool dots = false) { int x = right - Width(s, k) + 1; Draw(c, x, y, s, k, dots); return x; }
    public int Center(Cv c, int cx, int y, string s, int k = 1, bool dots = false) { int x = cx - Width(s, k) / 2; Draw(c, x, y, s, k, dots); return x; }

    public static readonly Fnt Small = MakeSmall(), Tiny = MakeTiny();

    static Fnt MakeSmall()   // 5 x 7
    {
        var f = new Fnt(7, 3);
        f.Add('0', ".XXX.", "X...X", "X...X", "X...X", "X...X", "X...X", ".XXX.");
        f.Add('1', ".X.", "XX.", ".X.", ".X.", ".X.", ".X.", "XXX");
        f.Add('2', ".XXX.", "X...X", "....X", "...X.", "..X..", ".X...", "XXXXX");
        f.Add('3', "XXXXX", "...X.", "..X..", "...X.", "....X", "X...X", ".XXX.");
        f.Add('4', "...X.", "..XX.", ".X.X.", "X..X.", "XXXXX", "...X.", "...X.");
        f.Add('5', "XXXXX", "X....", "XXXX.", "....X", "....X", "X...X", ".XXX.");
        f.Add('6', "..XX.", ".X...", "X....", "XXXX.", "X...X", "X...X", ".XXX.");
        f.Add('7', "XXXXX", "....X", "...X.", "..X..", ".X...", ".X...", ".X...");
        f.Add('8', ".XXX.", "X...X", "X...X", ".XXX.", "X...X", "X...X", ".XXX.");
        f.Add('9', ".XXX.", "X...X", "X...X", ".XXXX", "....X", "...X.", ".XX..");
        f.Add('%', "XX...", "XX..X", "...X.", "..X..", ".X...", "X..XX", "...XX");
        f.Add((char)176, ".X.", "X.X", ".X.");
        f.Add(':', ".", "X", ".", ".", ".", "X", ".");
        f.Add('-', "....", "....", "....", "XXXX");
        f.Add('!', "X", "X", "X", "X", "X", ".", "X");
        f.Add('.', ".", ".", ".", ".", ".", ".", "X");   // (decimals and his own label words, 11-13)
        f.Add('/', "....X", "...X.", "...X.", "..X..", ".X...", ".X...", "X....");
        f.Add('A', ".XXX.", "X...X", "X...X", "XXXXX", "X...X", "X...X", "X...X");
        f.Add('B', "XXXX.", "X...X", "X...X", "XXXX.", "X...X", "X...X", "XXXX.");
        f.Add('C', ".XXX.", "X...X", "X....", "X....", "X....", "X...X", ".XXX.");
        f.Add('D', "XXXX.", "X...X", "X...X", "X...X", "X...X", "X...X", "XXXX.");
        f.Add('E', "XXXXX", "X....", "X....", "XXXX.", "X....", "X....", "XXXXX");
        f.Add('F', "XXXXX", "X....", "X....", "XXXX.", "X....", "X....", "X....");
        f.Add('G', ".XXX.", "X...X", "X....", "X.XXX", "X...X", "X...X", ".XXXX");
        f.Add('H', "X...X", "X...X", "X...X", "XXXXX", "X...X", "X...X", "X...X");
        f.Add('I', "XXX", ".X.", ".X.", ".X.", ".X.", ".X.", "XXX");
        f.Add('J', "..XXX", "...X.", "...X.", "...X.", "...X.", "X..X.", ".XX..");
        f.Add('K', "X...X", "X..X.", "X.X..", "XX...", "X.X..", "X..X.", "X...X");
        f.Add('L', "X....", "X....", "X....", "X....", "X....", "X....", "XXXXX");
        f.Add('M', "X...X", "XX.XX", "X.X.X", "X.X.X", "X...X", "X...X", "X...X");
        f.Add('N', "X...X", "X...X", "XX..X", "X.X.X", "X..XX", "X...X", "X...X");
        f.Add('O', ".XXX.", "X...X", "X...X", "X...X", "X...X", "X...X", ".XXX.");
        f.Add('P', "XXXX.", "X...X", "X...X", "XXXX.", "X....", "X....", "X....");
        f.Add('Q', ".XXX.", "X...X", "X...X", "X...X", "X.X.X", "X..X.", ".XX.X");
        f.Add('R', "XXXX.", "X...X", "X...X", "XXXX.", "X.X..", "X..X.", "X...X");
        f.Add('S', ".XXXX", "X....", "X....", ".XXX.", "....X", "....X", "XXXX.");
        f.Add('T', "XXXXX", "..X..", "..X..", "..X..", "..X..", "..X..", "..X..");
        f.Add('U', "X...X", "X...X", "X...X", "X...X", "X...X", "X...X", ".XXX.");
        f.Add('V', "X...X", "X...X", "X...X", "X...X", "X...X", ".X.X.", "..X..");
        f.Add('W', "X...X", "X...X", "X...X", "X.X.X", "X.X.X", "X.X.X", ".X.X.");
        f.Add('X', "X...X", "X...X", ".X.X.", "..X..", ".X.X.", "X...X", "X...X");
        f.Add('Y', "X...X", "X...X", ".X.X.", "..X..", "..X..", "..X..", "..X..");
        f.Add('Z', "XXXXX", "....X", "...X.", "..X..", ".X...", "X....", "XXXXX");
        return f;
    }

    static Fnt MakeTiny()    // 3 x 5 (M, N, W wider)
    {
        var f = new Fnt(5, 2);
        f.Add('0', "XXX", "X.X", "X.X", "X.X", "XXX");
        f.Add('1', ".X", "XX", ".X", ".X", ".X");
        f.Add('2', "XXX", "..X", "XXX", "X..", "XXX");
        f.Add('3', "XXX", "..X", ".XX", "..X", "XXX");
        f.Add('4', "X.X", "X.X", "XXX", "..X", "..X");
        f.Add('5', "XXX", "X..", "XXX", "..X", "XXX");
        f.Add('6', "XXX", "X..", "XXX", "X.X", "XXX");
        f.Add('7', "XXX", "..X", "..X", ".X.", ".X.");
        f.Add('8', "XXX", "X.X", "XXX", "X.X", "XXX");
        f.Add('9', "XXX", "X.X", "XXX", "..X", "XXX");
        f.Add('%', "X.X", "..X", ".X.", "X..", "X.X");
        f.Add((char)176, "XX", "XX");
        f.Add('-', "...", "...", "XXX");
        f.Add('.', ".", ".", ".", ".", "X");   // (decimals and his own label words, 11-13; the letters it lacked)
        f.Add(':', ".", "X", ".", "X", ".");
        f.Add('!', "X", "X", "X", ".", "X");
        f.Add('/', "..X", "..X", ".X.", "X..", "X..");
        f.Add('J', "..X", "..X", "..X", "X.X", ".X.");
        f.Add('Q', ".X.", "X.X", "X.X", "XX.", ".XX");
        f.Add('X', "X.X", "X.X", ".X.", "X.X", "X.X");
        f.Add('A', ".X.", "X.X", "XXX", "X.X", "X.X");
        f.Add('B', "XX.", "X.X", "XX.", "X.X", "XX.");
        f.Add('C', ".XX", "X..", "X..", "X..", ".XX");
        f.Add('D', "XX.", "X.X", "X.X", "X.X", "XX.");
        f.Add('E', "XXX", "X..", "XX.", "X..", "XXX");
        f.Add('F', "XXX", "X..", "XX.", "X..", "X..");
        f.Add('G', ".XX", "X..", "X.X", "X.X", ".XX");
        f.Add('H', "X.X", "X.X", "XXX", "X.X", "X.X");
        f.Add('I', "XXX", ".X.", ".X.", ".X.", "XXX");
        f.Add('K', "X.X", "X.X", "XX.", "X.X", "X.X");
        f.Add('L', "X..", "X..", "X..", "X..", "XXX");
        f.Add('M', "X...X", "XX.XX", "X.X.X", "X...X", "X...X");
        f.Add('N', "X..X", "XX.X", "X.XX", "X..X", "X..X");
        f.Add('O', ".X.", "X.X", "X.X", "X.X", ".X.");
        f.Add('P', "XX.", "X.X", "XX.", "X..", "X..");
        f.Add('R', "XX.", "X.X", "XX.", "X.X", "X.X");
        f.Add('S', ".XX", "X..", ".X.", "..X", "XX.");
        f.Add('T', "XXX", ".X.", ".X.", ".X.", ".X.");
        f.Add('U', "X.X", "X.X", "X.X", "X.X", "XXX");
        f.Add('V', "X.X", "X.X", "X.X", "X.X", ".X.");
        f.Add('W', "X...X", "X...X", "X.X.X", "X.X.X", ".X.X.");
        f.Add('Y', "X.X", "X.X", ".X.", ".X.", ".X.");
        f.Add('Z', "XXX", "..X", ".X.", "X..", "XXX");
        return f;
    }
}

// big digits from strokes on a 4 x 8 grid (cut corners), any size, t-pixel pen; fixed advance so numbers don't jump
static class Seg
{
    // a b c d e f g: top, top right, bottom right, bottom, bottom left, top left, middle
    static string Of(char ch)
    {
        switch (ch) { case '0': case 'O': return "abcdef"; case '1': return "bc"; case '2': return "abged"; case '3': return "abgcd"; case '4': return "fgbc"; case '5': return "afgcd";
            case '6': return "afgedc"; case '7': return "abc"; case '8': return "abcdefg"; case '9': return "abcdfg"; case '-': return "g"; case 'F': return "aefg"; default: return ""; }
    }
    public static int CharW(char ch, int w, int t) { return ch == '.' || ch == '1' ? t : w; }   // (a 1 only its pen wide: "2 1:32", 11-15)
    public static int Width(string s, int w, int t) { int x = 0; for (int i = 0; i < s.Length; i++) x += CharW(s[i], w, t) + (i > 0 ? t + 1 : 0); return x; }
    public static void Draw(Cv c, int x, int y, int w, int h, int t, string s)
    {
        for (int i = 0; i < s.Length; i++)
        {
            char ch = s[i];
            if (ch == '.') c.Block(x, y + h - t, t, t);
            else
            {
                string g = Of(ch); int hh = (h - t) / 2, rx = x + CharW(ch, w, t) - t;   // (the right side: a 1's at its left)
                foreach (char k in g)
                    switch (k)
                    {
                        case 'a': c.Block(x + 1, y, w - 2, t); break;
                        case 'g': c.Block(x + 1, y + hh, w - 2, t); break;
                        case 'd': c.Block(x + 1, y + h - t, w - 2, t); break;
                        case 'f': c.Block(x, y + 1, t, hh - 1); break;
                        case 'b': c.Block(rx, y + 1, t, hh - 1); break;
                        case 'e': c.Block(x, y + hh + t, t, h - hh - 2 * t); break;
                        case 'c': c.Block(rx, y + hh + t, t, h - hh - 2 * t); break;
                    }
            }
            x += CharW(ch, w, t) + t + 1;
        }
    }
}

static class Geo
{
    static readonly Dictionary<char, int[][]> S = new Dictionary<char, int[][]>
    {
        { '0', new[] { new[] { 1,0, 3,0, 4,1, 4,7, 3,8, 1,8, 0,7, 0,1, 1,0 } } },
        { '1', new[] { new[] { 0,1, 1,0, 1,8 } } },   // (one unit wide: no hole beside it, his "the 1 is a bit weird")
        { '2', new[] { new[] { 0,1, 1,0, 3,0, 4,1, 4,3, 3,4, 1,4, 0,5, 0,8, 4,8 } } },
        { '3', new[] { new[] { 0,1, 1,0, 3,0, 4,1, 4,3, 3,4, 4,5, 4,7, 3,8, 1,8, 0,7 }, new[] { 1,4, 3,4 } } },
        { '4', new[] { new[] { 0,0, 0,4, 1,5, 4,5 }, new[] { 4,0, 4,8 } } },
        { '5', new[] { new[] { 4,0, 0,0, 0,4, 3,4, 4,5, 4,7, 3,8, 1,8, 0,7 } } },
        { '6', new[] { new[] { 4,1, 3,0, 1,0, 0,1, 0,7, 1,8, 3,8, 4,7, 4,5, 3,4, 0,4 } } },
        { '7', new[] { new[] { 0,0, 4,0, 4,2, 2,5, 2,8 } } },
        { '8', new[] { new[] { 1,0, 3,0, 4,1, 4,3, 3,4, 1,4, 0,3, 0,1, 1,0 }, new[] { 1,4, 0,5, 0,7, 1,8, 3,8, 4,7, 4,5, 3,4 } } },
        { '9', new[] { new[] { 0,7, 1,8, 3,8, 4,7, 4,1, 3,0, 1,0, 0,1, 0,3, 1,4, 4,4 } } },
        { 'O', new[] { new[] { 1,0, 3,0, 4,1, 4,7, 3,8, 1,8, 0,7, 0,1, 1,0 } } },
        { 'F', new[] { new[] { 4,0, 0,0, 0,8 }, new[] { 0,4, 3,4 } } },
        { '-', new[] { new[] { 1,4, 3,4 } } },
        { '%', new[] { new[] { 0,1, 1,0, 2,1, 1,2, 0,1 }, new[] { 2,7, 3,6, 4,7, 3,8, 2,7 }, new[] { 4,0, 0,8 } } },   // (two small diamonds and the slash)
    };
    public static int Adv(int w, int t) { return w + t + 1; }
    public static int CharW(char ch, int w, int t) { return ch == '.' ? t : ((ch == '1' ? 1 : 4) * (w - t) + 2) / 4 + t; }
    public static int Width(string s, int w, int t) { int x = 0; for (int i = 0; i < s.Length; i++) x += CharW(s[i], w, t) + (i > 0 ? t + 1 : 0); return x; }
    public static void Char(Cv c, int x, int y, int w, int h, int t, char ch)
    {
        if (ch == '.') { c.Block(x, y + h - t, t, t); return; }   // (a decimal point: one pen dot on the line, 11-13)
        int[][] st; if (!S.TryGetValue(ch, out st)) return;
        foreach (var p in st)
            for (int k = 0; k + 3 < p.Length; k += 2)
                c.Line(x + (p[k] * (w - t) + 2) / 4, y + (p[k + 1] * (h - t) + 4) / 8, x + (p[k + 2] * (w - t) + 2) / 4, y + (p[k + 3] * (h - t) + 4) / 8, t);
    }
    public static int Draw(Cv c, int x, int y, int w, int h, int t, string s)
    {
        int x0 = x;
        for (int i = 0; i < s.Length; i++) { Char(c, x, y, w, h, t, s[i]); x += CharW(s[i], w, t) + t + 1; }
        return Width(s, w, t);
    }
    public static int Right(Cv c, int right, int y, int w, int h, int t, string s) { int x = right - Width(s, w, t) + 1; Draw(c, x, y, w, h, t, s); return x; }
}

// small pictures
static class Ico
{
    public static readonly string[] Clock = {   // (11-17: the clock's own icon; Label Icon showed its name, TIME)
        "..XXX..",
        ".X.X.X.",
        "X..X..X",
        "X..XX.X",
        "X.....X",
        ".X...X.",
        "..XXX..",
    };
    public static readonly string[] Headset = {
        "..XXXXX..",
        ".X.....X.",
        "X.......X",
        "X.......X",
        "XX.....XX",
        "XXX...XXX",
        "XXX...XXX",
        ".XX...XX.",
    };
    public static readonly string[] Mouse = {
        ".XXXXX.",
        "X..X..X",
        "X..X..X",
        "XXXXXXX",
        "X.....X",
        "X.....X",
        "X.....X",
        ".XXXXX.",
    };
    public static readonly string[] Speaker = {
        "...X.....",
        "..XX..X..",
        "XXXX...X.",
        "XXXX...X.",
        "XXXX...X.",
        "..XX..X..",
        "...X.....",
    };
    public static readonly string[] Mute = {
        "...X.....",
        "..XX.....",
        "XXXX.X.X.",
        "XXXX..X..",
        "XXXX.X.X.",
        "..XX.....",
        "...X.....",
    };
    public static readonly string[] Bolt = {
        "...XX",
        "..XX.",
        ".XX..",
        "XXXXX",
        "..XX.",
        ".XX..",
        "XX...",
    };
    public static readonly string[] Zz = {
        "XXX....",
        "..X....",
        ".X.XXX.",
        "XXX..X.",
        "....X..",
        "...XXX.",
    };
    // a battery lying down: w x 7 with its tip, filled to pct in steps of 2 columns (empty: outline only)
    public static void Battery(Cv c, int x, int y, int w, int pct)
    {
        c.Rect(x, y, w - 1, 7);
        c.VLine(x + w - 1, y + 2, y + 4);
        if (pct <= 0) return;
        int inner = w - 5, f = Math.Max(1, (inner * Math.Min(100, pct) + 50) / 100);
        c.Block(x + 2, y + 2, f, 3);
    }
    public static int BatteryW = 13;
}

// what every design reads the same way
static class HsSt
{
    public static bool On(HsInfo i) { return i.Now.Second % 2 == 0; }                                   // blink phase
    public static bool LowHead(HsInfo i) { return !i.HeadOff && i.Head >= 0 && i.Head <= HeadEst.Low && !i.HeadCharging; }   // (the base's step 0: the headset's own beeps start there, 11-17; was 12, the whole 6.6 h of step 1)
    public static bool LowMouse(HsInfo i) { return i.Mouse >= 0 && i.Mouse <= 15 && !i.MouseCharging; }
    public static bool Swap(HsInfo i) { return LowHead(i) && !i.SpareOut && i.Spare >= 50; }
    public static string Pct(int p) { return p < 0 ? "-" : p + "%"; }
    public static string Num(int p) { return p < 0 ? "-" : p.ToString(); }
    public static string Deg(double d) { return double.IsNaN(d) ? "-" : Math.Round(d).ToString("0"); }
    public static int Segs(int p, int n) { return p <= 0 ? 0 : Math.Max(1, Math.Min(n, (p * n + 50) / 100)); }
}

static class G
{
    public static readonly string D = ((char)176).ToString();
    public static void BmpK(Cv c, int x, int y, string[] rows, int k)
    {
        for (int r = 0; r < rows.Length; r++) for (int col = 0; col < rows[r].Length; col++) if (rows[r][col] == 'X') c.Block(x + col * k, y + r * k, k, k);
    }
    public static int W(string[] rows) { int w = 0; foreach (var r in rows) w = Math.Max(w, r.Length); return w; }
    // asleep: a small "zZ", 7 x 7
    public static void Zz(Cv c, int x, int y) { Fnt.Tiny.Draw(c, x, y + 2, "Z"); Fnt.Tiny.Draw(c, x + 4, y, "Z"); }
    // the empty spare slot: a battery's outline, half lit
    public static void Ghost(Cv c, int x, int y, int w) { int t = c.Tone; c.Tone = 1; Ico.Battery(c, x, y, w, 0); c.Tone = t; }
}

// layout.cs: the customizable headset page (round 2 mock, his 11-12: "make it customizable ... maybe add a clock, only
// 2 rows, maybe 3 rows, maybe just 1 column or 3, maybe a different graphs"). A page is a grid of Rows x Cols; pieces go
// in his order into the first free place their size fits (W columns x H rows). A piece is the clock or one reading
// drawn in a style: number, bar, ring, knob or graph. Every piece picks the biggest text that fits its own box, and
// nothing draws past its box (Cv counts it if it tries).

class HsPiece
{
    public bool AsNum;                  // (11-15: a ring or knob too small for its dial, drawn as a number this time)
    public bool LabCut;                 // (11-16: its label left out, no room for it inside its dial)
    public string Src = "cpu";          // clock, cpu, gpu, head, spare, mouse, vol, or one of his readings
    public string Style = "number";     // number, bar, ring, knob, graph
    public string Label = "icon";       // icon, name, off (no icon for this reading: its name)
    public string At = "beside";        // number: the label beside the value or above it (his pick; never chosen for him, 11-13)
    public string Name;                 // the name shown (capitals); null: the reading's short name
    public string Src2;                 // graph: a second reading, dotted
    public string Graph = "line";       // graph: line, smooth, steps, area, bars, dots
    public int Over = 120;              // graph: seconds across its width
    // his 11-13 "everything and anything the hw deck offers for editing": as a cell's own settings
    public string Size = "auto";        // text: auto (the biggest that fits), s, m, l (the most it grows to)
    public string Align = "auto";       // auto, left, middle, right
    public int Dec;                     // decimals, 0 to 2
    public bool Unit = true;            // the unit after the value
    public double Warn = double.NaN, Crit = double.NaN;   // yellow and red levels: past yellow the piece turns over, past red it blinks so
    public bool? Below;                 // the levels count downwards (null: a battery's do, the rest upwards)
    public double Lo = double.NaN, Hi = double.NaN;       // graph: its own low and high (NaN: from what it shows)
    public bool Seconds, Date = true;   // clock
    public bool H12;                    // (11-17) clock: 12 hours, AM / PM small after it
    public string DateAt = "under", DateFmt = "day";   // (11-17) clock: its date under the time or beside it; day (MON 17 NOV), short (17 NOV), num (17/11), wday (MON)
    public bool DateCut, SecCut;        // (11-17) clock: its date / seconds left out this time, no room in its cell
    public int W = 1, H = 1;            // size in grid cells
    public int X = -1, Y = -1, Bx, By, Bw, Bh;   // where it landed (cells; box in pixels)
    public int AtX = -1, AtY = -1;     // a fixed place in the grid (his rows, x-hspage.cs); -1: the first free one
    public bool Shared;                 // another piece shares one of its rows (then a number's label and value sit together in the middle)
    public int Harm;                    // the text height its row shares (0: its own), set by Hs.Harmony
    public bool NoNum;                  // its number hidden (bar, ring, knob, graph; his 11-13 "a digit hider (keeping only bar)")
    public string NameSz = "auto";      // (11-14) its name's size: auto, small, tiny
    public string OffAs = "word", OffTxt, ChgAs = "blink";
    public string LowAs = "icon";       // (11-15) a battery under its low level (Crit; when none: the headset 2, its own beeps; the spare 12, the mouse 15): what blinks, none / icon / num / both   // (11-14) a battery off / empty: its word, his own word (OffTxt), a dash or nothing; charging: the bolt blinking, steady or hidden
    public int Dig = -1;                // (11-14) its own big digits (0 to 3); -1: the theme's
    public bool Inv;                    // (11-14) turned over: lit box, dark text (a warning still blinks)
    // (11-16 his "give people freedom, just how you do in PC screen") the number (V), its unit (U) and its label (I: icon
    // or name) each sized (K; 0: as before) and nudged (X, Y in screen pixels) on their own; the unit at the number's
    // bottom (as before), middle, top or under it; FX..FH: its place on a free page (page pixels; FX -1: none)
    public int VH, WK, BK, UK, IK = 1, VX, VY, UX, UY, IX, IY; public string UAt = "bottom";   // (11-16 round 2: VH the number's height in pixels, WK a word's size, BK the bolt's / zZ's)
    public int FX = -1, FY, FW, FH;
    // (11-17 his states) St: each state's own look (the piece with that state's keys over its own), StRaw: those keys as
    // saved; Force: the state the editor's preview shows (that picture only); Of / StNm: a state's look drawn for piece Of
    // in state StNm; StIco: the icon in a state (auto: an empty spare's dim, else as normal; normal; dim; own: his drawing
    // under "<src>.<state>"); KAt: the bolt / zZ in the icon's place (auto, as before) or beside the number; KX, KY its move
    public Dictionary<string, HsPiece> St; public Dictionary<string, object> StRaw; public string Force, StNm, StIco = "auto", KAt = "auto"; public HsPiece Of; public int KX, KY;
    public HsPiece Copy() { return (HsPiece)MemberwiseClone(); }
}

class HsLayout
{
    public int Rows = 2, Cols = 2;
    public bool Lines;                  // dotted lines between pieces
    public int Gap = -1;                // px between pieces; -1: 5 with lines, 4 without (his 11-13)
    public bool SolidLines, SolidBar;   // (v3) lines solid, not dotted; bars filled, not in blocks
    public int Digits = 1;              // (v3) the theme's big digit design: 0 strokes, 1 pixels, 2 thick strokes, 3 segments
    public Dictionary<string, string[]> Icons;   // (v3, 11-14) the theme's own icons by key; null: the built-in ones
    public List<HsPiece> Pieces = new List<HsPiece>();
    public bool Free;                   // (11-16) every piece at its own place (FX..FH), no lines
    public int[,] Own; public int[] ColX, ColW, RowY, RowH;   // (set by Place)
}

static class Hs
{
    static readonly string DG = ((char)176).ToString();
    public static readonly Dictionary<string, double> Extra = new Dictionary<string, double>();      // his other readings (mock: made up)
    public static readonly Dictionary<string, double[]> Hist = new Dictionary<string, double[]>();   // one value a second, newest last
    // his readings (HsPage.Feed): unit (degrees C shown as the degree sign), name in capitals, the top of a bar or ring
    public static readonly Dictionary<string, string> Units = new Dictionary<string, string>(), Names = new Dictionary<string, string>();
    public static readonly Dictionary<string, double> Maxes = new Dictionary<string, double>();

    // ---- readings ----
    class Src { public string Key, Name, Unit; public string[] Icon; public bool Batt; public double Max = 100, Span = 20; }
    // (11-14, his "logo editor") the theme's own icons: head, spare (the battery's outline; its level still fills it),
    // mouse, vol, mute, bolt, or any reading's key (CPU, GPU, ...: it then has an icon like the batteries)
    public static Dictionary<string, string[]> Icons;
    static string[] IconFor(string key, string[] dflt) { string[] r; return Icons != null && key != null && Icons.TryGetValue(key, out r) && r != null && r.Length > 0 ? r : dflt; }
    static Src Info(string k) { var s = Info0(k); var ic = k == "spare" ? null : IconFor(k, null); if (ic != null) s.Icon = ic; return s; }
    static Src Info0(string k)
    {
        switch (k)
        {
            case "cpu": return new Src { Key = k, Name = "CPU", Unit = DG };
            case "gpu": return new Src { Key = k, Name = "GPU", Unit = DG };
            case "head": return new Src { Key = k, Name = "HEADSET", Unit = "%", Icon = Ico.Headset, Batt = true };
            case "spare": return new Src { Key = k, Name = "SPARE", Unit = "%", Batt = true };
            case "mouse": return new Src { Key = k, Name = "MOUSE", Unit = "%", Icon = Ico.Mouse, Batt = true };
            case "vol": return new Src { Key = k, Name = "VOLUME", Unit = "%", Icon = Ico.Speaker };
            case "gpupow": return new Src { Key = k, Name = "GPU POWER", Unit = "W", Max = 450, Span = 60 };
            case "cpuuse": return new Src { Key = k, Name = "CPU USE", Unit = "%" };
            default: { string u, n; double mx; Units.TryGetValue(k, out u); Names.TryGetValue(k, out n); return new Src { Key = k, Name = n ?? k.ToUpperInvariant(), Unit = u ?? "", Max = Maxes.TryGetValue(k, out mx) ? mx : 100 }; }
        }
    }
    class Val { public double V = double.NaN; public string T = "-", U = ""; public bool Chg, ChgSteady, Low, Sleep, Empty, Off, HideIco, HideNum, Mute, Unmute; public double Frac { get { return double.IsNaN(V) ? 0 : V; } } }
    static Val Get(HsInfo i, string k)
    {
        var v = new Val(); var s = Info(k);
        switch (k)
        {
            case "cpu": v.V = i.Cpu; break;
            case "gpu": v.V = i.Gpu; break;
            case "head": if (i.HeadOff) { v.Off = true; v.T = "OFF"; return v; } v.V = i.Head; v.Chg = i.HeadCharging; break;   // (11-14 no hidden low flash: a piece warns by its own levels, his "no warning is set but it's blinking?")
            case "spare": if (i.SpareOut) { v.Empty = true; v.T = "EMPTY"; return v; } v.V = i.Spare; v.Chg = i.SpareCharging; break;
            case "mouse": v.V = i.Mouse; v.Chg = i.MouseCharging; v.Sleep = i.MouseAsleep; break;
            case "vol": v.V = i.Volume; break;
            default: double d; if (Extra.TryGetValue(k, out d)) v.V = d; break;
        }
        if (s.Batt || k == "vol") { if (v.V < 0) v.V = double.NaN; }
        if (!double.IsNaN(v.V)) { v.T = Math.Round(v.V).ToString("0"); v.U = s.Unit; }
        return v;
    }
    // ======== 11-17 his "I cant customize the empty and empty icon without changing the main view ... this should be
    // customizable properly": each special state of a piece its own look ========
    // the spare's Empty, the headset's Off, no reading, charging, the mouse asleep, low, the volume muted: each may set its
    // own keys over the piece's (St: parsed as a piece of its own); what it doesn't set follows the normal look. The
    // editor's preview forces one state on one piece (Force), for its picture only
    public static readonly string[] StNames = { "empty", "off", "none", "chg", "sleep", "low", "mute" };
    static double LowAt(HsPiece p) { return double.IsNaN(p.Crit) ? (p.Src == "mouse" ? 15 : p.Src == "head" ? HeadEst.Low : 12) : p.Crit; }
    // the state a piece is in now (null: its normal look; a clock and a reading of the PC have none)
    public static string StateOf(HsInfo i, HsPiece p)
    {
        if (p.Src == "clock") return null;
        if (p.Force != null) return p.Force == "norm" ? null : p.Force;   // (Normal: as it would look reading normally)
        var v = Get(i, p.Src); var s = Info(p.Src);
        if (v.Empty) return "empty"; if (v.Off) return "off";
        if (!s.Batt && p.Src != "vol") return null;
        if (double.IsNaN(v.V)) return "none";
        if (v.Chg) return "chg"; if (v.Sleep) return "sleep";
        if (s.Batt && v.V <= LowAt(p)) return "low";
        if (p.Src == "vol" && v.V == 0) return "mute";
        return null;
    }
    // the piece as it draws now: its state's own look over its own (a copy that knows its piece), or itself
    static HsPiece Look(HsInfo i, HsPiece p)
    {
        HsPiece q; string st = StateOf(i, p);
        if (st == null || p.St == null || !p.St.TryGetValue(st, out q)) return p;
        var r = p.Copy(); r.Of = p; r.StNm = st;
        r.Label = q.Label; r.At = q.At; r.Name = q.Name; r.Size = q.Size; r.Align = q.Align; r.Dec = q.Dec; r.Unit = q.Unit; r.NoNum = q.NoNum; r.NameSz = q.NameSz; r.Dig = q.Dig; r.Inv = q.Inv;
        r.OffAs = q.OffAs; r.OffTxt = q.OffTxt; r.ChgAs = q.ChgAs; r.LowAs = q.LowAs; r.StIco = q.StIco; r.KAt = q.KAt; r.KX = q.KX; r.KY = q.KY;
        r.VH = q.VH; r.WK = q.WK; r.BK = q.BK; r.UK = q.UK; r.IK = q.IK; r.VX = q.VX; r.VY = q.VY; r.UX = q.UX; r.UY = q.UY; r.IX = q.IX; r.IY = q.IY; r.UAt = q.UAt;
        return r;
    }
    // the editor's preview of a state: the reading as it would be then (its own value kept where it has one)
    static Val Forced(HsInfo i, HsPiece p, string k, Val v)
    {
        var s = Info(k); string f = p.Force;
        if (f == "empty") return new Val { Empty = true, T = "EMPTY" };
        if (f == "off") return new Val { Off = true, T = "OFF" };
        if (f == "none") return new Val();
        var r = new Val { V = double.IsNaN(v.V) ? (k == "spare" ? 100 : s.Batt ? 64 : 50) : v.V, Unmute = f != "mute" };   // (norm: this, no state)
        if (f == "norm" && s.Batt && r.V <= LowAt(p)) r.V = Math.Min(100, Math.Max(k == "spare" ? 100 : 64, Math.Floor(LowAt(p)) + 1));   // (Normal of a battery reading low now: an ordinary level, no blink, the review 11-17)
        if (f == "norm" && k == "vol" && r.V <= 0) r.V = 50;
        if (f == "low") { double lo = Math.Round(LowAt(p)); r.V = Math.Max(1, Math.Min(r.V, lo > 6 ? lo - 4 : lo - 1)); }
        else if (f == "chg") r.Chg = true; else if (f == "sleep") r.Sleep = true; else if (f == "mute") { r.V = 0; r.Mute = true; }
        if (!double.IsNaN(r.V)) { r.T = Math.Round(r.V).ToString("0"); r.U = s.Unit; }
        return r;
    }
    // a part's box logged for a state's look: the piece's own (the reply goes by the page's pieces)
    static bool Same(object o, HsPiece p) { var q = o as HsPiece; return q == p || (q != null && q.Of == p); }
    // (11-17) the bolt / zZ beside the number: blinking there too when he put it there (Bolt place Beside); its box
    static void MarkAt(Cv c, HsInfo i, HsPiece p, Val v, int x, int y, int vh)
    {
        if (!v.Chg && !v.Sleep) return;
        int k = MarkK(v, vh, p.BK), w, h, y0;
        if (v.Chg) { var bo = IconFor("bolt", Ico.Bolt); w = G.W(bo) * k; h = bo.Length * k; y0 = y + (vh - h) / 2; } else { w = h = 7 * k; y0 = y + (vh - 7 * k) / 2; }
        PartBox(p, "mark", x, y0, w, h);
        if (v.Chg && p.KAt == "beside" && !v.ChgSteady && i.Now.Second % 2 != 0) return;
        Mark(c, v, x, y, vh, p.BK);
    }
    static double scLo = double.NaN, scHi = double.NaN;   // (the piece being drawn: his own low / high, 11-14)
    static double Frac(Src s, Val v)
    {
        if (double.IsNaN(v.V)) return 0;
        double lo = double.IsNaN(scLo) ? 0 : scLo, hi = double.IsNaN(scHi) ? s.Max : scHi; if (hi <= lo) hi = lo + 1;
        return Math.Max(0, Math.Min(1, (v.V - lo) / (hi - lo)));
    }
    // a piece's value as it shows it: its decimals, its unit or none
    static Val Get(HsInfo i, HsPiece p, string k)
    {
        var v = Get(i, k);
        if (p.Force != null && k == p.Src) v = Forced(i, p, k, v);   // (11-17 the editor's preview of one state)
        if (!double.IsNaN(v.V)) { v.T = v.V.ToString("F" + Math.Max(0, Math.Min(2, p.Dec)), CultureInfo.InvariantCulture); if (!p.Unit) v.U = ""; }
        // (11-14 his "when it's empty, when its off, when its charging the blinking thunder, all this should be customizable")
        if (v.Off || v.Empty) { if (p.OffAs == "dash") v.T = "-"; else if (p.OffAs == "blank") v.T = " "; else if (!string.IsNullOrEmpty(p.OffTxt)) v.T = p.OffTxt; }
        if (v.Chg) { if (p.ChgAs == "none") v.Chg = false; else if (p.ChgAs == "steady") v.ChgSteady = true; }
        // (11-15 his Battery section: under its low level its label, its number or both are hidden every other second)
        if (Info(k).Batt && !double.IsNaN(v.V) && v.V <= (double.IsNaN(p.Crit) ? (k == "mouse" ? 15 : k == "head" ? HeadEst.Low : 12) : p.Crit) && !HsSt.On(i))
        {
            string la = p.LowAs; bool lab = p.Label != "off", num = !p.NoNum || p.Style == "number";   // (a part it doesn't show: the other one blinks instead)
            if (la == "icon" && !lab) la = "num"; else if (la == "num" && !num) la = "icon";
            v.HideIco = (la == "icon" || la == "both") && !(v.Chg && p.Style != "graph");   // (charging: its bolt has the label's place every other second; a graph has no bolt)
            v.HideNum = la == "num" || la == "both";
        }
        return v;
    }
    static Val Get(HsInfo i, HsPiece p) { return Get(i, p, p.Src); }
    // the tallest text a piece's size allows (auto: whatever fits)
    static int Cap(HsPiece p) { return p.Size == "s" ? 7 : p.Size == "m" ? 18 : p.Size == "l" ? 30 : AutoCap; }
    // past its levels: 0 no, 1 yellow, 2 red
    public static int Level(HsInfo i, HsPiece p)
    {
        if (p.Src == "clock" || (double.IsNaN(p.Warn) && double.IsNaN(p.Crit)) || Info(p.Src).Batt) return 0;   // (11-15 a battery: its Battery section blinks a part, it never turns over)
        double v = Get(i, p.Src).V; if (double.IsNaN(v)) return 0;
        bool down = p.Below ?? Info(p.Src).Batt;
        Func<double, bool> past = t => !double.IsNaN(t) && (down ? v <= t : v >= t);
        return past(p.Crit) ? 2 : past(p.Warn) ? 1 : 0;
    }

    // ---- number fonts: our big stroke digits at a few sizes, then the 5 x 7 and the 3 x 5 pixel fonts ----
    // the big digits: the labels' own 5 x 7 pixel font scaled, Auto at most 3x (21 px) (his pick B 11-13, after "the big
    // headset 62% the number is so big and weird and ugly"; 0 the old strokes, 2 thick strokes, 3 segments stay for a try)
    public static int BigStyle = 1, AutoCap = 22;
    class NF
    {
        public int K, W, H, T, St;  // K 0 big, 1 small, 2 tiny; St the big ones' design: 0 strokes, 1 pixels, 2 thick strokes, 3 segments
        public bool Bold;           // (thick strokes at 7 px: the 1 px strokes twice, a pixel apart; a 2 px pen there made blobs, 11-15)
        static readonly int[][] Sizes = { new[] { 23, 43, 3 }, new[] { 18, 34, 2 }, new[] { 16, 30, 2 }, new[] { 14, 26, 2 }, new[] { 12, 22, 2 }, new[] { 10, 18, 2 }, new[] { 8, 14, 2 } };
        public static IEnumerable<NF> All(bool big)
        {
            if (big && BigStyle == 1) foreach (int k in new[] { 6, 5, 4, 3, 2 }) yield return new NF { K = 0, St = 1, W = 5 * k, H = 7 * k, T = k };
            else if (big)
            {
                for (int h = 43; h >= 8; h--) yield return At(h, true);   // (every height, as his own size: the Sizes rows alone left Auto 22, 18, 14 or 7, his 11-17 "auto sizing ... pretty bad")
                yield return new NF { K = 0, St = BigStyle, W = 5, H = 7, T = 1, Bold = BigStyle == 2 };   // (a 7 px step of its design: a tight box keeps the theme's digits, not the plain 5 x 7 font, 11-15)
            }
            yield return new NF { K = 1 }; yield return new NF { K = 2 };
        }
        // (11-16 his "isn't there more steps we can put?") the digits at a height of his own: Blocky (the 5 x 7 font scaled) in
        // steps of 7, the other designs at any height from 7 to 43, their width and pen between the Sizes rows (as the rows
        // at a row's height); 5 or 6: the 3 x 5 font; a word in a design with no letters: the 5 x 7 font
        public static NF At(int vh, bool big)
        {
            if (vh <= 6) return new NF { K = 2 };
            if (!big) return new NF { K = 1 };
            if (BigStyle == 1) { int k = Math.Min(6, vh / 7); return k <= 1 ? new NF { K = 1 } : new NF { K = 0, St = 1, W = 5 * k, H = 7 * k, T = k }; }
            int h = Math.Min(43, vh);
            if (h <= 7) return new NF { K = 0, St = BigStyle, W = 5, H = 7, T = 1, Bold = BigStyle == 2 };
            int[] a = { 5, 7, 1 }, b = Sizes[0];
            foreach (var r in Sizes) { if (r[1] <= h && r[1] > a[1]) a = r; if (r[1] >= h && r[1] < b[1]) b = r; }
            int w = b[1] == a[1] ? a[0] : (int)Math.Round(a[0] + (b[0] - a[0]) * (h - a[1]) / (double)(b[1] - a[1])), t0 = h == b[1] ? b[2] : a[2];
            int t = BigStyle == 2 ? Math.Max(t0 + 1, (h + 3) / 7) : BigStyle == 3 ? (h < 14 ? 1 : Math.Max(2, h / 9)) : t0;   // (segments under 14: a 1 px pen, a 2 px one turned the 1 into a colon)
            return new NF { K = 0, St = BigStyle, W = w, H = h, T = t };
        }
        // a word (EMPTY, OFF, his own) at his own size: the 5 x 7 font times k, whatever the digits' design
        public static NF Word(int k) { return k <= 1 ? new NF { K = 1 } : new NF { K = 0, St = 1, W = 5 * k, H = 7 * k, T = k }; }
        public int Ht { get { return K == 0 ? H : K == 1 ? 7 : 5; } }
        Fnt F { get { return K == 1 ? Fnt.Small : Fnt.Tiny; } }
        public int Gap { get { return K == 0 ? (St == 1 ? T : T + 1) : 1; } }   // (the pixel digits: their % as far as a digit, 11-13)
        public int TextW(string s) { return K != 0 ? F.Width(s) : St == 1 ? Fnt.Small.Width(s, T) : St == 3 ? Seg.Width(s, W, T) : Bold ? BoldW(s) : Geo.Width(s, W, T); }
        int BoldW(string s) { int x = 0; for (int i = 0; i < s.Length; i++) x += Geo.CharW(s[i], W, T) + 1 + (i > 0 ? T + 1 : 0); return x; }
        public void Text(Cv c, int x, int y, string s)
        {
            if (K != 0) F.Draw(c, x, y, s);
            else if (St == 1) Fnt.Small.Draw(c, x, y, s, T);
            else if (St == 3) Seg.Draw(c, x, y, W, H, T, s);
            else if (Bold) foreach (char ch in s) { Geo.Char(c, x, y, W, H, T, ch); Geo.Char(c, x + 1, y, W, H, T, ch); x += Geo.CharW(ch, W, T) + 1 + T + 1; }
            else Geo.Draw(c, x, y, W, H, T, s);
        }
        int PW { get { return Math.Max(7, W * 2 / 3); } }
        int PH { get { return Math.Max(10, H * 11 / 20); } }
        int PT { get { return T >= 3 ? 2 : T; } }
        int DS { get { return Math.Max(3, W / 4); } }
        Fnt UF { get { return H >= 22 ? Fnt.Small : Fnt.Tiny; } }
        int PK { get { return St == 1 ? Math.Max(1, T - 1) : H >= 34 ? 3 : 2; } }   // (the % beside big digits: the 5 x 7 font's, scaled; the stroke one read as an "x", 11-13; beside the pixel digits a step smaller than them)
        public int UnitW(string u)
        {
            if (u == "") return 0;
            if (K != 0) return F.Width(u);
            if (u == "%") return H >= 14 ? Fnt.Small.Width("%", PK) : H < 14 ? Fnt.Small.Width("%") : Geo.CharW('%', PW, PT);   // (the 7 px step: the 5 x 7 font's %)
            if (u == DG) return DS;
            return UF.Width(u);
        }
        public void Unit(Cv c, int x, int y, string u)
        {
            if (u == "") return;
            if (K != 0) { F.Draw(c, x, y, u); return; }
            if (u == "%") { if (H >= 14) Fnt.Small.Draw(c, x, y + H - 7 * PK, "%", PK); else if (H < 14) Fnt.Small.Draw(c, x, y + H - 7, "%"); else Geo.Char(c, x, y + H - PH, PW, PH, PT, '%'); }
            else if (u == DG) { c.Rect(x, y, DS, DS); if (T >= 3) c.Rect(x + 1, y + 1, DS - 2, DS - 2); }
            else UF.Draw(c, x, y + H - UF.H, u);
        }
        public int ValueW(string s, string u) { return TextW(s) + (u == "" ? 0 : Gap + UnitW(u)); }
        // (11-16) the unit's height, and how far under the number's top Unit draws it
        public int UnitH(string u) { if (u == "") return 0; if (K != 0) return F.H; if (u == "%") return H >= 14 ? 7 * PK : H < 14 ? 7 : PH; if (u == DG) return DS; return UF.H; }
        public int UnitOff(string u) { if (u == "" || K != 0) return 0; if (u == "%") return H >= 14 ? H - 7 * PK : H < 14 ? H - 7 : H - PH; if (u == DG) return 0; return H - UF.H; }
        // the theme's digits at 7 px (a bar's number); Blocky: none, its 7 px step is the 5 x 7 font itself
        public static NF Seven() { if (BigStyle == 1) return null; foreach (var f in All(true)) if (f.K == 0 && f.H == 7) return f; return null; }
        public void Value(Cv c, int x, int y, string s, string u) { Text(c, x, y, s); if (u != "") Unit(c, x + TextW(s) + Gap, y, u); }
    }
    static bool Letters(string s) { bool a = false; foreach (char ch in s) { if (ch >= 'A' && ch <= 'Z') a = true; else if (!char.IsDigit(ch) && ch != '-' && ch != '.' && ch != ' ') return false; } return a; }
    static bool BigOk(string s) { if (BigStyle == 1 && Letters(s)) return true; foreach (char ch in s) if (!char.IsDigit(ch) && ch != 'O' && ch != 'F' && ch != '-' && ch != '.') return false; return true; }
    static NF Fit(int maxW, int maxH, string s, string u)
    {
        NF last = null;
        foreach (var f in NF.All(BigOk(s))) { last = f; if (f.Ht <= maxH && f.ValueW(s, u) <= maxW) return f; }
        return last;
    }

    // ---- labels: an icon (headset, spare, mouse, volume) or the name ----
    class Lab { public int Kind, W, H; public string[] Icon; public bool Batt, Mini; public string Word; public Fnt F; public int Dim = -1; }   // (Dim 11-17: 1 dim, 0 as normal, -1 as before)
    static Lab Label(HsPiece p, Src s, int bw, int bh)
    {
        var l = new Lab();
        if (p.Label == "off") return l;
        if (p.Label == "icon" && (s.Icon != null || s.Key == "spare"))
        {
            l.Kind = 1;
            if (s.Key == "spare") { l.Batt = true; var sp = IconFor("spare", null); if (sp != null) { l.Icon = sp; l.W = G.W(sp); l.H = sp.Length; } else { l.W = 13; l.H = 7; } } else { l.Icon = s.Icon; l.W = G.W(s.Icon); l.H = s.Icon.Length; }
            l.Mini = false;
            l.Dim = p.StIco == "dim" ? 1 : p.StIco == "normal" ? 0 : -1;   // (11-17 a state's icon)
            if (p.StIco == "own" && p.StNm != null) { var ow = IconFor(p.Src + "." + p.StNm, null); if (ow != null) { l.Icon = ow; l.W = G.W(ow); l.H = ow.Length; l.Dim = 0; } }   // (his own drawing for this state)
            return l;
        }
        l.Kind = 2; l.Word = p.Name ?? s.Name;
        l.F = p.NameSz == "small" ? Fnt.Small : p.NameSz == "tiny" ? Fnt.Tiny : bh >= 9 && Fnt.Small.Width(l.Word) <= bw / 2 ? Fnt.Small : Fnt.Tiny;
        l.W = l.F.Width(l.Word); l.H = l.F.H;
        return l;
    }
    static void DrawLabel(Cv c, HsInfo i, Lab l, Src s, Val v, int x, int y)
    {
        if (v.HideIco) return;   // (its low blink)
        if (l.Kind == 1)
        {
            bool dim = l.Dim < 0 ? v.Empty : l.Dim > 0;   // (11-17: a state's icon dim or as normal; as before an empty spare's dim)
            if (l.Batt && l.Mini) { int t = c.Tone; if (dim) c.Tone = 1; c.Rect(x, y, 10, 5); c.Set(x + 10, y + 2); c.Tone = t; if (!v.Empty && v.Frac > 0) c.HLine(x + 2, x + 2 + Math.Max(0, (int)Math.Round(5 * Math.Min(100, v.Frac) / 100)), y + 2); }
            else if (l.Batt && l.Icon != null) Spare(c, l.Icon, x, y, v, dim);
            else if (l.Batt) { if (v.Empty && dim) G.Ghost(c, x, y, 13); else { int t = c.Tone; if (dim) c.Tone = 1; Ico.Battery(c, x, y, 13, (int)v.Frac); c.Tone = t; } }
            else { int t = c.Tone; if (dim) c.Tone = 1; c.Bmp(x, y, s.Key == "vol" && (v.Mute || (i.Volume == 0 && !v.Unmute)) && l.Icon == s.Icon ? IconFor("mute", Ico.Mute) : l.Icon); c.Tone = t; }
        }
        else if (l.Kind == 2) { int t = c.Tone; if (l.Dim > 0) c.Tone = 1; l.F.Draw(c, x, y, l.Word); c.Tone = t; }
    }
    // his own spare battery outline: drawn as he made it (half lit when the slot is empty), its level filled in the
    // same place as the built-in one's (2 in from the left and top, 3 short of the right, 2 short of the bottom)
    static void Spare(Cv c, string[] rows, int x, int y, Val v, bool dim)
    {
        int t = c.Tone; if (dim) c.Tone = 1; c.Bmp(x, y, rows); c.Tone = t;
        int w = G.W(rows), h = rows.Length, inner = w - 5, pct = (int)v.Frac;
        if (v.Empty || pct <= 0 || inner < 1 || h < 5) return;
        c.Block(x + 2, y + 2, Math.Max(1, (inner * Math.Min(100, pct) + 50) / 100), h - 4);
    }
    // a bolt while charging, "zZ" while asleep, beside the value (2x next to big numbers)
    // (11-16) the mark at his own size k (bk), 0: the bolt 2x by a big number as before, zZ always 1x as before
    static int MarkK(Val v, int vh, int bk) { return bk > 0 ? bk : v.Chg && vh >= 26 ? 2 : 1; }
    static int MarkW(Val v, int vh, int bk) { int k = MarkK(v, vh, bk); return v.Chg ? G.W(IconFor("bolt", Ico.Bolt)) * k + 2 * k : v.Sleep ? 9 * k : 0; }
    static void Mark(Cv c, Val v, int x, int y, int vh, int bk)
    {
        int k = MarkK(v, vh, bk);
        if (v.Chg) { var bo = IconFor("bolt", Ico.Bolt); G.BmpK(c, x, y + (vh - bo.Length * k) / 2, bo, k); }
        else if (v.Sleep) { if (k <= 1) G.Zz(c, x, y + (vh - 7) / 2); else { int y0 = y + (vh - 7 * k) / 2; Fnt.Tiny.Draw(c, x, y0 + 2 * k, "Z", k); Fnt.Tiny.Draw(c, x + 4 * k, y0, "Z", k); } }
    }
    static int MarkW(Val v, int vh) { int k = vh >= 26 ? 2 : 1; return v.Chg ? G.W(IconFor("bolt", Ico.Bolt)) * k + 2 * k : v.Sleep ? 9 : 0; }
    static void Mark(Cv c, Val v, int x, int y, int vh)
    {
        int k = vh >= 26 ? 2 : 1;
        if (v.Chg) { var bo = IconFor("bolt", Ico.Bolt); G.BmpK(c, x, y + (vh - bo.Length * k) / 2, bo, k); }
        else if (v.Sleep) G.Zz(c, x, y + (vh - 7) / 2);
    }

    // ---- the page ----
    public static int Gap(HsLayout L) { return L.Gap >= 0 ? L.Gap : L.Lines ? 5 : 4; }
    public static void Place(HsLayout L)
    {
        var own = new int[L.Rows, L.Cols];
        for (int r = 0; r < L.Rows; r++) for (int c = 0; c < L.Cols; c++) own[r, c] = -1;
        int g = Gap(L);
        int[] cx = new int[L.Cols], cw = new int[L.Cols], ry = new int[L.Rows], rh = new int[L.Rows];
        Split(Cv.W, L.Cols, g, cx, cw); Split(Cv.H, L.Rows, g, ry, rh);
        for (int k = 0; k < L.Pieces.Count; k++)
        {
            var p = L.Pieces[k]; p.X = p.Y = -1;
            if (L.Free && p.FX >= 0 && p.FW > 0) { p.X = p.Y = 0; p.Bx = Math.Min(p.FX, Cv.W - 1); p.By = Math.Max(0, Math.Min(p.FY, Cv.H - 1)); p.Bw = Math.Max(1, Math.Min(p.FW, Cv.W - p.Bx)); p.Bh = Math.Max(1, Math.Min(p.FH, Cv.H - p.By)); continue; }   // (11-16 a free page: its own place)
            int w = Math.Min(p.W, L.Cols), h = Math.Min(p.H, L.Rows);
            if (p.AtX >= 0 && p.AtY >= 0)
            {
                bool fit = p.AtX + w <= L.Cols && p.AtY + h <= L.Rows;
                for (int ya = 0; fit && ya < h; ya++) for (int xa = 0; xa < w; xa++) if (own[p.AtY + ya, p.AtX + xa] >= 0) fit = false;
                if (fit)
                {
                    int rr = p.AtY, cc = p.AtX;
                    for (int ya = 0; ya < h; ya++) for (int xa = 0; xa < w; xa++) own[rr + ya, cc + xa] = k;
                    p.X = cc; p.Y = rr;
                    p.Bx = cx[cc]; p.Bw = cx[cc + w - 1] + cw[cc + w - 1] - cx[cc];
                    p.By = ry[rr]; p.Bh = ry[rr + h - 1] + rh[rr + h - 1] - ry[rr];
                }
                continue;
            }
            for (int r = 0; r + h <= L.Rows && p.X < 0; r++)
                for (int c = 0; c + w <= L.Cols && p.X < 0; c++)
                {
                    bool free = true;
                    for (int a = 0; a < h; a++) for (int b = 0; b < w; b++) if (own[r + a, c + b] >= 0) free = false;
                    if (!free) continue;
                    for (int a = 0; a < h; a++) for (int b = 0; b < w; b++) own[r + a, c + b] = k;
                    p.X = c; p.Y = r;
                    p.Bx = cx[c]; p.Bw = cx[c + w - 1] + cw[c + w - 1] - cx[c];
                    p.By = ry[r]; p.Bh = ry[r + h - 1] + rh[r + h - 1] - ry[r];
                }
        }
        L.Own = own; L.ColX = cx; L.ColW = cw; L.RowY = ry; L.RowH = rh;
        foreach (var p in L.Pieces)
        {
            p.Shared = false; if (L.Free) { p.Shared = p.X >= 0; continue; }
            foreach (var q in L.Pieces)
                if (q != p && q.X >= 0 && p.X >= 0 && q.Y < p.Y + Math.Min(p.H, L.Rows) && p.Y < q.Y + Math.Min(q.H, L.Rows)) p.Shared = true;   // (any piece, not only a number: beside a bar or the clock too, his 11-13 "auto is broken in the mouse")
        }
    }
    static void Split(int total, int n, int g, int[] at, int[] size)
    {
        int room = total - (n - 1) * g, b = room / n, extra = room - b * n, x = 0;
        for (int k = 0; k < n; k++) { size[k] = b + (k < extra ? 1 : 0); at[k] = x; x += size[k] + g; }
    }

    public static Cv Draw(HsLayout L, HsInfo i)
    {
        BigStyle = L.Digits; solidBar = L.SolidBar; Icons = L.Icons;   // (the theme's look; every drawing runs under HsPage's lock)
        Place(L);
        Harmony(L, i);
        var c = new Cv(i.Dx, i.Dy);
        foreach (var p0 in L.Pieces)
        {
            if (p0.X < 0) continue;
            var p = Look(i, p0);   // (11-17 its state's own look: Empty, Off, charging ...)
            int lv = LvOf(i, p), x0 = p.Bx, y0 = p.By, w0 = p.Bw, h0 = p.Bh;
            BigStyle = p.Dig >= 0 ? p.Dig : L.Digits;
            // (a pixel of air on each side beside the lines, his 11-13 "pieces are too cramped"; past a level, two, and
            // one above and below, inside the box turned over around it)
            Inset(L, p, lv);
            c.ClipTo(p.Bx, p.By, p.Bw, p.Bh);
            Piece(c, i, p);
            p.Bx = x0; p.By = y0; p.Bw = w0; p.Bh = h0;
            int raw = Level(i, p); if (p.Inv ^ (raw == 1) ^ (raw == 2 && HsSt.On(i))) c.Invert(p.Bx, p.By, p.Bw, p.Bh);   // (yellow: turned over, red: blinking so; on a piece turned over by his pick a warning flips it back, the tester's F15 11-15)
        }
        BigStyle = L.Digits;
        c.NoClip();
        if (L.Lines && Gap(L) >= 3) Lines(c, L);   // (a dotted line needs a pixel of air on each side)
        return c;
    }

    static void Inset(HsLayout L, HsPiece p, int lv)
    {
        int pad = lv > 0 ? 2 : L.Lines && p.Bw > 12 ? 1 : 0;
        p.Bx += pad; p.Bw -= 2 * pad; if (lv > 0) { p.By += 1; p.Bh -= 2; }
    }
    // pieces side by side in one row drawn alike (numbers, or rings and knobs) share one text size: the smallest any of
    // them needs for the widest value it shows (his 11-13: a 100% smaller than the 62% beside it, an icon above one
    // number and beside the next, "this should not happen")
    static int LvOf(HsInfo i, HsPiece p) { int lv = Level(i, p); return p.Inv && lv == 0 ? 1 : lv; }   // (turned over by his pick: drawn as a yellow level is)
    public static void Harmony(HsLayout L, HsInfo i)
    {
        // (11-17 his "auto sizing ... pretty bad": a row shared one size, but cells of one size in another row had their own
        // (18 px over 22 px on his page). Now a row, and cells of one size anywhere on the page (3 px either way), are one
        // group: the smallest size of them all; decimals still never pull a group down)
        var ps = new List<HsPiece>(); var hs = new List<int>(); var ks = new List<string>(); var rk = new List<string>(); var ws = new List<int>(); var hh = new List<int>(); var dec = new List<bool>();
        foreach (var p0 in L.Pieces)
        {
            p0.Harm = 0; var p = Look(i, p0);   // (11-17 measured in its state's look; the size goes to the piece)
            if (p.X < 0 || p.Src == "clock" || p.VH > 0) continue;   // (11-16: his own height sizes on its own; a word at his size measures 0, so skips while it shows)
            bool dial = p.Style == "ring" || p.Style == "knob"; if (!dial && p.Style != "number") continue;
            int x0 = p.Bx, y0 = p.By, w0 = p.Bw, h0 = p.Bh;
            Inset(L, p, LvOf(i, p)); BigStyle = p.Dig >= 0 ? p.Dig : L.Digits;
            string kind = dial ? "r" : "n";
            int h = dial ? Ring(null, i, p, p.Style == "knob", true) : Number(null, i, p, true);
            if (h < 0) { kind = "n"; h = Number(null, i, p, true); }   // (a ring too small for its number is drawn as a number: sized with the numbers beside it)
            p.Bx = x0; p.By = y0; p.Bw = w0; p.Bh = h0;
            if (h <= 0) continue;   // (an empty spare's ring: no number to size)
            ps.Add(p0); hs.Add(h); ks.Add(kind); rk.Add(L.Free ? kind + "f" + y0 + "/" + h0 : kind + p.Y + "/" + Math.Min(p.H, L.Rows)); ws.Add(w0); hh.Add(h0); dec.Add(p.Dec > 0);
        }
        int n = ps.Count; var up = new int[n]; for (int k = 0; k < n; k++) up[k] = k;
        Func<int, int> root = null; root = k => up[k] == k ? k : (up[k] = root(up[k]));
        for (int a = 0; a < n; a++) for (int b = a + 1; b < n; b++)
            if (ks[a] == ks[b] && (rk[a] == rk[b] || (Math.Abs(ws[a] - ws[b]) <= 3 && Math.Abs(hh[a] - hh[b]) <= 3))) up[root(a)] = root(b);
        var min = new Dictionary<int, int>(); var cnt = new Dictionary<int, int>();
        for (int k = 0; k < n; k++) { int r = root(k); int c; cnt.TryGetValue(r, out c); cnt[r] = c + 1; if (dec[k]) continue; int m; min[r] = min.TryGetValue(r, out m) ? Math.Min(m, hs[k]) : hs[k]; }
        for (int k = 0; k < n; k++) { int r = root(k), m; if (cnt[r] >= 2 && min.TryGetValue(r, out m)) ps[k].Harm = m; }   // (a decimals piece takes its group's size, never sets it)
    }
    // the widest value a piece shows: a percentage 100, else its digits as 0s (the widest digit). Drawn at that one's
    // size, a number keeps its size as it changes (62 to 100, 9 to 10)
    static string Widest(HsPiece p, Src s, Val v)
    {
        string dec = p.Dec > 0 ? "." + new string('0', Math.Min(2, p.Dec)) : "";
        if (s.Unit == "%") return "100" + dec;
        var b = new StringBuilder(); foreach (char ch in v.T) b.Append(char.IsDigit(ch) ? '0' : ch);
        string w = b.ToString(); return w.IndexOf('0') >= 0 && BigOk(w) ? w : "00" + dec;
    }

    // dotted lines in the gaps between two different pieces
    static void Lines(Cv c, HsLayout L)
    {
        int g = Gap(L), h = g / 2, st = L.SolidLines ? 1 : 2;   // (v3: solid lines, every pixel)
        // (one line through a whole run, not one per unit with a break at each gap, his 11-13 "lines look bad"; their ends
        // 2 px short, so where a row's line meets a column's they don't touch)
        for (int k = 0; k + 1 < L.Cols; k++)
            for (int r = 0; r < L.Rows; )
            {
                if (!(L.Own[r, k] != L.Own[r, k + 1] && (L.Own[r, k] >= 0 || L.Own[r, k + 1] >= 0))) { r++; continue; }
                int r1 = r; while (r1 + 1 < L.Rows && L.Own[r1 + 1, k] != L.Own[r1 + 1, k + 1] && (L.Own[r1 + 1, k] >= 0 || L.Own[r1 + 1, k + 1] >= 0)) r1++;
                int x = L.ColX[k + 1] - g + h, y0 = L.RowY[r] + 1, y1 = L.RowY[r1] + L.RowH[r1] - 2;   // (a pixel short: a one-unit row keeps a line, not two dots)
                for (int y = y0; y <= y1; y += st) c.Set(x, y);
                r = r1 + 1;
            }
        for (int r = 0; r + 1 < L.Rows; r++)
            for (int k = 0; k < L.Cols; )
            {
                if (!(L.Own[r, k] != L.Own[r + 1, k] && (L.Own[r, k] >= 0 || L.Own[r + 1, k] >= 0))) { k++; continue; }
                int k1 = k; while (k1 + 1 < L.Cols && L.Own[r, k1 + 1] != L.Own[r + 1, k1 + 1] && (L.Own[r, k1 + 1] >= 0 || L.Own[r + 1, k1 + 1] >= 0)) k1++;
                int y = L.RowY[r + 1] - g + h, x0 = L.ColX[k] + 2, x1 = L.ColX[k1] + L.ColW[k1] - 3;
                for (int x = x0; x <= x1; x += st) c.Set(x, y);
                k = k1 + 1;
            }
    }

    static void LabelOnly(Cv c, HsInfo i, HsPiece p)   // (v3: a dial too small with its number hidden: its label alone, in the middle)
    {
        if (p.Label == "off") return;
        var s = Info(p.Src); var v = Get(i, p); var l = Label(p, s, p.Bw, p.Bh);
        DrawLabel(c, i, l, s, v, p.Bx + (p.Bw - l.W) / 2, p.By + (p.Bh - l.H) / 2);
    }
    static void Piece(Cv c, HsInfo i, HsPiece p)
    {
        if (p.Src == "clock") { Clock(c, i, p); return; }
        scLo = p.Lo; scHi = p.Hi;
        switch (p.Style)
        {
            case "bar": Bar(c, i, p); break;
            case "ring": Ring(c, i, p, false); break;
            case "knob": Ring(c, i, p, true); break;
            case "graph": Graph(c, i, p); break;
            default: Number(c, i, p); break;
        }
        scLo = scHi = double.NaN;
    }

    // ---- number: the label beside the value, or above it when he picks that (never switched for him: his 11-13 "some
    // have the icon on top of the number and some have them side by side. this should not happen"); the size the
    // widest value it shows fits, at most its row's (measure: only that size) ----
    static int Number(Cv c, HsInfo i, HsPiece p, bool measure = false)
    {
        if (!measure && PartLog != null && p.Src != "clock") { WkLog(i, p); FitLog(i, p); }   // (11-16 F50 / F51: vhmax, bkmax for the editor)   // (11-16 review: wkmax for the editor)
        if (ForceX || Opt(p) || (!measure && WordCase(i, p)) || (!measure && PartLog != null && StateOf(i, p) != null)) return NumberX(c, i, p, measure);   // (11-17: in the editor, a state's parts boxed)   // (11-16)
        int bx = p.Bx, by = p.By, bw = p.Bw, bh = p.Bh;
        var s = Info(p.Src); var v = Get(i, p); bool on = HsSt.On(i);
        var l = Label(p, s, bw, bh);
        int cap = Cap(p); if (p.Harm > 0) cap = Math.Min(cap, p.Harm);
        bool above = p.At == "above" && l.Kind > 0 && bh - (l.H + 2) >= 5;   // (a row too low for a label over a value: beside, the review 11-13)
        // charging: its bolt takes the label's place every other second, as in a ring. No room is kept for it beside
        // the value, so the number keeps its size (and its row's) while the spare charges in the base
        // (asleep, a mouse: its zZ beside the value, steady; its room is kept for a mouse always, so falling asleep
        // changes no size)
        bool swap = v.Chg && l.Kind > 0;
        int lw = !above && l.Kind > 0 ? l.W + 3 : 0, lh = above ? l.H + 2 : 0, room = bw - lw - Math.Max(s.Key == "mouse" ? 9 : 0, swap ? 0 : MarkW(v, 26));
        var f = Fit(room - AutoEdge(), Math.Min(bh - lh, cap), Widest(p, s, v), v.U);   // (2 px clear at each side, the three designs, 11-17)
        if (measure) return f.Ht;
        if (f.ValueW(v.T, v.U) > room || (f.K == 0 && !BigOk(v.T))) f = Fit(room, Math.Min(bh - lh, f.Ht), v.T, v.U);   // (OFF, EMPTY: in letters)
        int vw = f.ValueW(v.T, v.U), mw = swap ? 0 : MarkW(v, f.Ht);
        bool markNow = swap && (v.ChgSteady || i.Now.Second % 2 == 0);   // (steady: the bolt stays)
        bool dim = v.Low && !on;
        if (above)
        {
            int gap = f.K == 0 ? 4 : 2, rw = vw + (mw > 0 ? gap + mw : 0);   // (the value and its mark)
            int lx = p.Align == "middle" ? bx + (bw - l.W) / 2 : p.Align == "right" ? bx + bw - l.W : bx;
            int vx = p.Align == "middle" ? bx + (bw - rw) / 2 : p.Align == "right" ? bx + bw - rw : bx;
            if (markNow) Mark(c, v, lx + Math.Max(0, (l.W - (v.Chg ? G.W(IconFor("bolt", Ico.Bolt)) : 7)) / 2), by, l.H);
            else if (!(dim && !(f.K == 0 && f.H > 7))) DrawLabel(c, i, l, s, v, lx, by);
            if (l.Kind > 0) PartBox(p, "icon", lx, by, l.W, l.H);
            int vy = by + lh + (bh - lh - f.Ht) / 2;
            if (dim && f.K == 0 && f.H > 7) c.Tone = 1;   // (the 7 px step dims as the small font, review 11-15)
            c.Hush = v.HideNum; f.Value(c, vx, vy, v.T, v.U); c.Hush = false; c.Tone = 0;
            PartsOf(p, f, vx, vy, v);
            if (!swap) Mark(c, v, vx + vw + gap, vy, f.Ht);
        }
        else
        {
            int group = lw + mw + vw;
            bool middle = p.Align == "middle" || (p.Align == "auto" && (bh >= 20 || p.Shared));   // a big box, or a number beside another: label and value together in the middle; else (a list) the value on the right edge
            int gx = p.Align == "left" ? bx : p.Align == "right" ? bx + bw - group : bx + (bw - group) / 2;
            int vx = middle || p.Align != "auto" ? gx + lw + mw : bx + bw - vw;
            int lx = middle || p.Align != "auto" ? gx : bx;
            int vy = by + (bh - f.Ht) / 2;
            if (markNow) Mark(c, v, lx + Math.Max(0, (l.W - (v.Chg ? G.W(IconFor("bolt", Ico.Bolt)) : 7)) / 2), by + (bh - l.H) / 2, l.H);
            else if (!(dim && !(f.K == 0 && f.H > 7))) DrawLabel(c, i, l, s, v, lx, by + (bh - l.H) / 2);
            if (l.Kind > 0) PartBox(p, "icon", lx, by + (bh - l.H) / 2, l.W, l.H);
            if (!swap) Mark(c, v, vx - mw, vy, f.Ht);
            if (dim && f.K == 0 && f.H > 7) c.Tone = 1;   // (the 7 px step dims as the small font, review 11-15)
            c.Hush = v.HideNum; f.Value(c, vx, vy, v.T, v.U); c.Hush = false; c.Tone = 0;
            PartsOf(p, f, vx, vy, v);
        }
        return f.Ht;
    }

    // ---- bar: label, bar, value on one line; label and value over the bar when the box is tall ----
    // ======== 11-16 the number in parts (his "give people freedom, just how you do in PC screen") ========
    // the number, its unit and its label (icon or name) each sized and nudged on their own; the unit at the number's
    // bottom (as before), middle, top or under it; the label beside it (left, as before), above, right or below. Nothing
    // set: the old Number draws; NumberX with every option at its default draws the same pixels (ForceX, the checks)
    internal static bool ForceX;
    public static List<object[]> PartLog;   // (the editor's picture only: each part's box in page pixels, while set)
    static void PartBox(HsPiece p, string part, int x, int y, int w, int h) { if (PartLog != null && w > 0 && h > 0) PartLog.Add(new object[] { p, part, x, y, w, h }); }
    static void PartsOf(HsPiece p, NF f, int vx, int vy, Val v)
    {
        if (PartLog == null) return;
        int tw = f.TextW(v.T); PartBox(p, "value", vx, vy, tw, f.Ht);
        if (v.U != "") PartBox(p, "unit", vx + tw + f.Gap, vy + f.UnitOff(v.U), f.UnitW(v.U), f.UnitH(v.U));
    }
    // the reply's "parts": a piece each, in the page's order: null (not a number) or {icon, value, unit: [x, y, w, h]} in
    // the rects' fractions
    public static List<object> PartsReply(List<HsPiece> ps, List<object[]> log)
    {
        Func<double, double> F = d => Math.Round(d, 5);
        var l = new List<object>();
        foreach (var p in ps)
        {
            Dictionary<string, object> d = null;
            if (p.X >= 0 && log != null) foreach (var e in log) if (Same(e[0], p) && e.Length == 6) { if (d == null) d = new Dictionary<string, object>(); d[(string)e[1]] = new object[] { F(((int)e[2] + 1) / 128.0), F(((int)e[3] + 1) / 64.0), F((int)e[4] / 128.0), F((int)e[5] / 64.0) }; }
            l.Add(d);
        }
        return l;
    }
    static int AutoEdge() { return BigStyle == 1 ? 0 : 4; }   // (Auto's room kept clear at a cell's sides: Strokes, Thick strokes, Seven segments filled their cells edge to edge, his 11-17)
    static bool Opt(HsPiece p) { return p.KAt != "auto" || p.KX != 0 || p.KY != 0 || p.VH > 0 || p.WK > 0 || p.BK > 0 || p.UK > 0 || p.IK > 1 || p.VX != 0 || p.VY != 0 || p.UX != 0 || p.UY != 0 || p.IX != 0 || p.IY != 0 || p.UAt != "bottom" || p.At != "beside"; }   // (above too: centred as beside is in a big box, his mock 11-16)
    // EMPTY, OFF or his own word (in letters): drawn the new way, which may put the label above to draw it bigger
    static bool WordCase(HsInfo i, HsPiece p) { if (p.At != "beside" || p.Label == "off" || BigStyle != 1) return false; var v = Get(i, p); return (v.Empty || v.Off) && Letters(v.T); }
    // the label above when that draws the word bigger than beside it (his "make it default as well")
    // (11-16 review) a word at his size: the largest k from k0 down that fits beside its label (or alone), or above it when
    // its label is beside (NumberX's own gaps and mark room); 0: none fits. up: it fits only above
    static int WordFitK(HsPiece p, Src s, Val v, int kind, int LW, int LH, int bw, int bh, int k0, string t, out bool up)
    {
        int ik = Math.Max(1, p.IK), sg = ik > 1 ? 4 : 3, vg = ik > 1 ? 4 : 2;
        int mk = Math.Max(s.Key == "mouse" ? 9 * Math.Max(1, p.BK) : 0, v.Chg && kind > 0 ? 0 : MarkW(v, 26, p.BK));
        bool vertAt = (p.At == "above" || p.At == "below") && kind > 0 && bh - (LH + vg) >= 5, canUp = p.At == "beside" && kind > 0 && bh - (LH + vg) >= 5;
        up = false;
        for (int k = k0; k >= 1; k--)
        {
            var w = NF.Word(k); int ww = w.TextW(t), wh = w.Ht;
            if (vertAt) { if (ww <= bw - mk && wh <= bh - (LH + vg)) return k; continue; }
            if (ww <= bw - (kind > 0 ? LW + sg : 0) - mk && wh <= bh) return k;
            if (canUp && ww <= bw - mk && wh <= bh - (LH + vg)) { up = true; return k; }
        }
        return 0;
    }
    // the largest word size that fits this piece now (its word: the one showing, else EMPTY / OFF / his own), for the editor
    static void WkLog(HsInfo i, HsPiece p)
    {
        var s = Info(p.Src); var v = Get(i, p);
        bool shows = (v.Empty || v.Off) && Letters(v.T);
        string t = shows ? v.T : p.OffAs == "word" && (p.Src == "spare" || p.Src == "head") ? (p.OffTxt ?? (p.Src == "spare" ? "EMPTY" : "OFF")) : null;
        if (t == null || !Letters(t)) return;
        var v2 = shows ? v : new Val { T = t, Empty = p.Src == "spare", Off = p.Src != "spare" };
        var l = Label(p, s, p.Bw, p.Bh); int ik = Math.Max(1, p.IK); bool up;
        PartLog.Add(new object[] { p, "#wkmax", WordFitK(p, s, v2, l.Kind, l.W * ik, l.H * ik, p.Bw, p.Bh, 4, t, out up) });
    }
    // (11-16 the tester's F50) the tallest set height this number piece's widest value, unit and label fit its box at, as it
    // is set now (label place and size, unit place and size; the nudges left out): the heights the Size slider offers. And
    // (F51) the largest bolt / zZ size that draws differently from the one under it, where it shows now
    // (11-16 the tester's F52) the tallest of his own heights this number fits its box at, as FitLog measures it for the
    // Size slider (0: none fits): a height set in another digit design is drawn at this one
    static int VhBest(HsInfo i, HsPiece p)
    {
        int bw = p.Bw, bh = p.Bh;
        var s = Info(p.Src); var v = Get(i, p);
        var l = Label(p, s, bw, bh);
        int ik = Math.Max(1, p.IK), LW = l.W * ik, LH = l.H * ik, sg = ik > 1 ? 4 : 3, vg = ik > 1 ? 4 : 2;
        bool vert = (p.At == "above" || p.At == "below") && l.Kind > 0 && bh - (LH + vg) >= 5;
        bool swap = v.Chg && l.Kind > 0 && p.KAt != "beside";
        string u = v.U, t = Widest(p, s, v); bool under = p.UAt == "under" && u != "";
        int res = s.Key == "mouse" ? 9 * Math.Max(1, p.BK) : 0;   // (the room a mouse keeps for its zZ)
        int[] hs = BigStyle == 1 ? new[] { 42, 35, 28, 21, 14, 7, 5 } : new[] { 43, 42, 41, 40, 39, 38, 37, 36, 35, 34, 33, 32, 31, 30, 29, 28, 27, 26, 25, 24, 23, 22, 21, 20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5 };
        int best = 0;
        foreach (int h in hs)
        {
            var f = NF.At(h, BigOk(t));
            int tw = f.TextW(t), th = f.Ht, uw = u == "" ? 0 : p.UK > 0 ? Fnt.Small.Width(u, p.UK) : f.UnitW(u), uh = u == "" ? 0 : p.UK > 0 ? 7 * p.UK : f.UnitH(u), bw0, bh0;
            if (u == "") { bw0 = tw; bh0 = th; }
            else
            {
                int ux, uy;
                if (under) { ux = tw - uw; uy = th + 2; } else { ux = tw + f.Gap; uy = p.UAt == "top" ? 0 : p.UAt == "middle" ? (th - uh) / 2 : p.UK > 0 ? th - uh : f.UnitOff(u); }
                bw0 = Math.Max(tw, ux + uw) - Math.Min(0, ux); bh0 = Math.Max(th, uy + uh) - Math.Min(0, uy);
            }
            int mw = Math.Max(res, swap ? 0 : MarkW(v, f.Ht, p.BK)), w, ht;
            if (vert) { w = Math.Max(LW, bw0 + (mw > 0 ? (f.K == 0 ? 4 : 2) + mw : 0)); ht = LH + vg + bh0; }
            else { w = (l.Kind > 0 ? LW + sg : 0) + mw + bw0; ht = Math.Max(bh0, l.Kind > 0 ? LH : 0); }
            if (w <= bw && ht <= bh) { best = h; break; }
        }
        return best;
    }
    static void FitLog(HsInfo i, HsPiece p)
    {
        int bw = p.Bw, bh = p.Bh;
        var s = Info(p.Src); var v = Get(i, p);
        var l = Label(p, s, bw, bh);
        int ik = Math.Max(1, p.IK), LW = l.W * ik, LH = l.H * ik, sg = ik > 1 ? 4 : 3, vg = ik > 1 ? 4 : 2;
        bool vert = (p.At == "above" || p.At == "below") && l.Kind > 0 && bh - (LH + vg) >= 5;
        bool swap = v.Chg && l.Kind > 0 && p.KAt != "beside";
        string u = v.U, t = Widest(p, s, v); bool under = p.UAt == "under" && u != "";
        int res = s.Key == "mouse" ? 9 * Math.Max(1, p.BK) : 0;   // (the room a mouse keeps for its zZ)
        int[] hs = BigStyle == 1 ? new[] { 42, 35, 28, 21, 14, 7, 5 } : new[] { 43, 42, 41, 40, 39, 38, 37, 36, 35, 34, 33, 32, 31, 30, 29, 28, 27, 26, 25, 24, 23, 22, 21, 20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5 };
        int best = 0;
        foreach (int h in hs)
        {
            var f = NF.At(h, BigOk(t));
            int tw = f.TextW(t), th = f.Ht, uw = u == "" ? 0 : p.UK > 0 ? Fnt.Small.Width(u, p.UK) : f.UnitW(u), uh = u == "" ? 0 : p.UK > 0 ? 7 * p.UK : f.UnitH(u), bw0, bh0;
            if (u == "") { bw0 = tw; bh0 = th; }
            else
            {
                int ux, uy;
                if (under) { ux = tw - uw; uy = th + 2; } else { ux = tw + f.Gap; uy = p.UAt == "top" ? 0 : p.UAt == "middle" ? (th - uh) / 2 : p.UK > 0 ? th - uh : f.UnitOff(u); }
                bw0 = Math.Max(tw, ux + uw) - Math.Min(0, ux); bh0 = Math.Max(th, uy + uh) - Math.Min(0, uy);
            }
            int mw = Math.Max(res, swap ? 0 : MarkW(v, f.Ht, p.BK)), w, ht;
            if (vert) { w = Math.Max(LW, bw0 + (mw > 0 ? (f.K == 0 ? 4 : 2) + mw : 0)); ht = LH + vg + bh0; }
            else { w = (l.Kind > 0 ? LW + sg : 0) + mw + bw0; ht = Math.Max(bh0, l.Kind > 0 ? LH : 0); }
            if (w <= bw && ht <= bh) { best = h; break; }
        }
        PartLog.Add(new object[] { p, "#vhmax", best });
        if (!v.Chg && !v.Sleep) return;
        // the k each bk (0 auto, 1..3) draws: in the label's place capped as NumberX draws it, beside the number as Mark does
        int cap = Math.Max(1, Math.Min((LW + sg) / 5, (vert ? LH + vg - 1 : bh) / 7));
        var kOf = new int[4];
        for (int b = 0; b <= 3; b++)
        {
            if (swap) kOf[b] = Math.Max(1, Math.Min(MarkK(v, LH, b), cap));
            else kOf[b] = MarkK(v, NumberHt(i, p), b);
        }
        int bk = 0; for (int b = 3; b >= 1; b--) if (kOf[b] != kOf[b - 1]) { bk = b; break; }
        PartLog.Add(new object[] { p, "#bkmax", bk });
    }
    // the number's height as it draws now (the bolt's auto size beside it follows it)
    static int NumberHt(HsInfo i, HsPiece p)
    {
        var c0 = PartLog; PartLog = null;
        try { var t = new Cv(0, 0); t.ClipTo(p.Bx, p.By, p.Bw, p.Bh); return NumberX(t, i, p, false); }   // (on a scratch page: NumberX at its defaults draws as the old code)
        finally { PartLog = c0; }
    }
    public static List<object> TagReply(List<HsPiece> ps, List<object[]> log, string tag)
    {
        var l = new List<object>();
        foreach (var p in ps) { object k = null; if (log != null) foreach (var e in log) if (Same(e[0], p) && e.Length == 3 && (string)e[1] == tag) k = e[2]; l.Add(k); }
        return l;
    }
    public static List<object> WkReply(List<HsPiece> ps, List<object[]> log)
    {
        var l = new List<object>();
        foreach (var p in ps) { object k = null; if (log != null) foreach (var e in log) if (Same(e[0], p) && e.Length == 3 && (string)e[1] == "#wkmax") k = e[2]; l.Add(k); }
        return l;
    }
    static bool WordUp(HsPiece p, Src s, Val v, int kind, int lw0, int lh0, int bw, int bh, int cap)
    {
        if (p.At != "beside" || kind == 0 || !(v.Empty || v.Off) || !Letters(v.T) || bh - (lh0 + 2) < 5) return false;
        int mk = Math.Max(s.Key == "mouse" ? 9 * Math.Max(1, p.BK) : 0, v.Chg ? 0 : MarkW(v, 26, p.BK));
        if (p.WK > 0) { bool up; WordFitK(p, s, v, kind, lw0, lh0, bw, bh, p.WK, v.T, out up); return up; }   // (his own word size: above when only there it fits, the size stepped down to what fits)
        if (BigStyle != 1) return false;
        Func<int, int, int> word = (room, h) =>
        {
            var f = Fit(room, Math.Min(h, cap), Widest(p, s, v), v.U);
            if (f.ValueW(v.T, v.U) > room || (f.K == 0 && !BigOk(v.T))) f = Fit(room, Math.Min(h, f.Ht), v.T, v.U);
            return f.ValueW(v.T, v.U) <= room ? f.Ht : 0;
        };
        int ik0 = Math.Max(1, p.IK); return word(bw - mk, bh - (lh0 + (ik0 > 1 ? 4 : 2))) > word(bw - (lw0 + (ik0 > 1 ? 4 : 3)) - mk, bh);   // (NumberX's own gaps, the review 11-16)
    }
    // a label drawn k times bigger: drawn once on a scratch page, each lit pixel then a k x k block
    static void LabelK(Cv c, HsInfo i, Lab l, Src s, Val v, int x, int y, int k)
    {
        if (k <= 1) { DrawLabel(c, i, l, s, v, x, y); return; }
        var t = new Cv(0, 0); DrawLabel(t, i, l, s, v, 0, 0);
        for (int a = 0; a < l.W && a < 128; a++) for (int b = 0; b < l.H && b < 64; b++) if (t.Px[a, b]) c.Block(x + a * k, y + b * k, k, k);
    }
    static int NumberX(Cv c, HsInfo i, HsPiece p, bool measure)
    {
        int bx = p.Bx, by = p.By, bw = p.Bw, bh = p.Bh;
        var s = Info(p.Src); var v = Get(i, p); bool on = HsSt.On(i);
        var l = Label(p, s, bw, bh);
        int k = Math.Max(1, p.IK), LW = l.W * k, LH = l.H * k, sg = k > 1 ? 4 : 3, vg = k > 1 ? 4 : 2;
        int cap = Cap(p); if (p.Harm > 0) cap = Math.Min(cap, p.Harm);
        bool vert = (p.At == "above" || p.At == "below") && l.Kind > 0 && bh - (LH + vg) >= 5;
        bool wordUp = !measure && !vert && WordUp(p, s, v, l.Kind, LW, LH, bw, bh, cap); if (wordUp) vert = true;
        bool below = vert && p.At == "below", after = !vert && p.At == "right" && l.Kind > 0;
        bool swap = v.Chg && l.Kind > 0 && p.KAt != "beside";   // (11-17 Bolt place Beside: never in the icon's place)
        string u = v.U; bool under = p.UAt == "under" && u != "";
        int lw = !vert && l.Kind > 0 ? LW + sg : 0, lh = vert ? LH + vg : 0;
        int room = bw - lw - Math.Max(s.Key == "mouse" ? 9 * Math.Max(1, p.BK) : 0, swap ? 0 : MarkW(v, 26, p.BK)), roomH = bh - lh;
        Func<NF, int> UW = q => u == "" ? 0 : p.UK > 0 ? Fnt.Small.Width(u, p.UK) : q.UnitW(u);
        Func<NF, int> UH = q => u == "" ? 0 : p.UK > 0 ? 7 * p.UK : q.UnitH(u);
        // the number and its unit as one block: {width, height, the number's x, y in it, the unit's x, y}
        Func<NF, string, int[]> Blk = (q, t) =>
        {
            int tw = q.TextW(t), th = q.Ht, uw = UW(q), uh = UH(q), ux, uy;
            if (u == "") return new[] { tw, th, 0, 0, 0, 0 };
            if (under) { ux = tw - uw; uy = th + 2; }
            else { ux = tw + q.Gap; uy = p.UAt == "top" ? 0 : p.UAt == "middle" ? (th - uh) / 2 : p.UK > 0 ? th - uh : q.UnitOff(u); }
            int x0 = Math.Min(0, ux), y0 = Math.Min(0, uy), x1 = Math.Max(tw, ux + uw), y1 = Math.Max(th, uy + uh);
            return new[] { x1 - x0, y1 - y0, -x0, -y0, ux - x0, uy - y0 };
        };
        int edge = AutoEdge();   // (Auto: 2 px clear at each side, the three designs, 11-17)
        Func<string, int, NF> fit = (t, maxH) => { NF last = null; foreach (var q in NF.All(BigOk(t))) { last = q; var b = Blk(q, t); if (q.Ht <= maxH && b[0] <= room - edge && b[1] <= roomH) return q; } return last; };
        NF f;
        bool word = (v.Empty || v.Off) && Letters(v.T);
        if (word && p.WK > 0) { bool up0; f = NF.Word(Math.Max(1, WordFitK(p, s, v, l.Kind, LW, LH, bw, bh, p.WK, v.T, out up0))); if (measure) return 0; }   // (11-16 his "the size of ONLY the empty": the word's own size, the number's untouched)
        else if (p.VH > 0 && !word) { int vb = VhBest(i, p); f = NF.At(vb > 0 ? Math.Min(p.VH, vb) : p.VH, BigOk(v.T)); if (measure) return 0; }   // (never past what fits: a height kept from another digit design, the tester's F52 11-16)   // (his own height in pixels; not shared with its row)
        else
        {
            f = fit(Widest(p, s, v), Math.Min(roomH, cap));
            if (measure) return f.Ht;
            if (Blk(f, v.T)[0] > room || (f.K == 0 && !BigOk(v.T))) f = fit(v.T, Math.Min(roomH, f.Ht));   // (OFF, EMPTY: in letters)
        }
        var B = Blk(f, v.T); int bw0 = B[0], bh0 = B[1];
        int mw = swap ? 0 : MarkW(v, f.Ht, p.BK);
        bool markNow = swap && (v.ChgSteady || i.Now.Second % 2 == 0);
        bool dim = v.Low && !on;
        string al = wordUp && p.Align == "auto" ? "middle" : p.Align;
        int X, Y, LX, LY, MX, MY;   // the block's top left, the label's, the mark's
        if (vert)
        {
            int gap = f.K == 0 ? 4 : 2, rw = bw0 + (mw > 0 ? gap + mw : 0);
            bool mid = al == "middle" || (al == "auto" && (bh >= 20 || p.Shared));   // (11-16: auto as beside: together in the middle of a big box; was always left)
            LX = mid ? bx + (bw - LW) / 2 : al == "right" ? bx + bw - LW : bx;
            X = mid ? bx + (bw - rw) / 2 : al == "right" ? bx + bw - rw : bx;
            if (below) { Y = by + (bh - lh - bh0) / 2; LY = by + bh - LH; } else { LY = by; Y = by + lh + (bh - lh - bh0) / 2; }
            if (wordUp) { int gh = LH + vg + bh0; LY = by + (bh - gh) / 2; Y = LY + LH + vg; }   // (the word and its label together in the middle)
            MX = X + bw0 + gap; MY = Y + B[3];
        }
        else
        {
            int group = lw + mw + bw0;
            bool middle = al == "middle" || (al == "auto" && (bh >= 20 || p.Shared)), together = middle || al != "auto";
            int gx = al == "left" ? bx : al == "right" ? bx + bw - group : bx + (bw - group) / 2;
            if (!after) { X = together ? gx + lw + mw : bx + bw - bw0; LX = together ? gx : bx; }
            else if (together) { X = gx + mw; LX = gx + mw + bw0 + sg; }
            else { LX = bx + bw - LW; X = LX - sg - bw0; }
            Y = by + (bh - bh0) / 2; LY = by + (bh - LH) / 2;
            MX = X - mw; MY = Y + B[3];
        }
        X += p.VX; Y += p.VY; MX += p.VX; MY += p.VY; LX += p.IX; LY += p.IY; MX += p.KX; MY += p.KY;
        int nx = X + B[2], ny = Y + B[3], ux0 = X + B[4] + p.UX, uy0 = Y + B[5] + p.UY;
        if (swap) { var bo = IconFor("bolt", Ico.Bolt); int kb = Math.Max(1, Math.Min(MarkK(v, LH, p.BK), Math.Min((LW + sg) / 5, (vert ? LH + vg - 1 : bh) / 7))); int qx = LX + Math.Max(0, (LW - G.W(bo) * kb) / 2) + p.KX, qy = LY + (LH - bo.Length * kb) / 2 + p.KY; if (markNow) G.BmpK(c, qx, qy, bo, kb); PartBox(p, "mark", qx, qy, G.W(bo) * kb, bo.Length * kb); }   // (his bolt size, no bigger than the label's place holds: the review 11-16; 11-17 its own move, its box)
        if (!markNow && !(dim && !(f.K == 0 && f.H > 7))) LabelK(c, i, l, s, v, LX, LY, k);
        if (l.Kind > 0) PartBox(p, "icon", LX, LY, LW, LH);
        if (!swap && !vert) MarkAt(c, i, p, v, MX, MY, f.Ht);
        if (dim && f.K == 0 && f.H > 7) c.Tone = 1;   // (the 7 px step dims as the small font, review 11-15)
        c.Hush = v.HideNum; f.Text(c, nx, ny, v.T);
        if (u != "") { if (p.UK > 0) Fnt.Small.Draw(c, ux0, uy0, u, p.UK); else f.Unit(c, ux0, uy0 - f.UnitOff(u), u); }
        c.Hush = false; c.Tone = 0;
        if (!swap && vert) MarkAt(c, i, p, v, MX, MY, f.Ht);
        PartBox(p, "value", nx, ny, f.TextW(v.T), f.Ht); if (u != "") PartBox(p, "unit", ux0, uy0, UW(f), UH(f));
        return f.Ht;
    }

    static void Bar(Cv c, HsInfo i, HsPiece p)
    {
        int bx = p.Bx, by = p.By, bw = p.Bw, bh = p.Bh;
        var s = Info(p.Src); var v = Get(i, p); bool on = HsSt.On(i);
        var l = Label(p, s, bw, bh);
        var vf = bh >= 7 && p.Size != "s" ? Fnt.Small : Fnt.Tiny;
        string vt = v.T + v.U; var nf = vf == Fnt.Small && BigOk(v.T) ? NF.Seven() : null;   // (the theme's digits, 11-15; Blocky and words: the 5 x 7 font)
        int vw = nf != null ? nf.ValueW(v.T, v.U) : vf.Width(vt), mw = v.Chg ? 7 : v.Sleep ? 9 : 0;
        Action<int, int> num = (x, y) => { if (nf != null) nf.Value(c, x, y, v.T, v.U); else vf.Draw(c, x, y, vt); };
        bool hideLab = v.Low && !on;
        if (bh >= 16)
        {
            int ly = by + (bh - 7 - 3 - Math.Min(5, bh - 10)) / 2;
            if (!hideLab) DrawLabel(c, i, l, s, v, bx, ly + (7 - l.H) / 2);
            if (!p.NoNum) { c.Hush = v.HideNum; num(bx + bw - vw, ly); c.Hush = false; Mark(c, v, bx + bw - vw - mw, ly, 7); }
            int barH = Math.Min(5, bh - 10);
            DrawBar(c, i, s, v, bx, bx + bw - 1, ly + 10 + barH / 2, barH);
        }
        else
        {
            int ly = by + (bh - l.H) / 2, vy = by + (bh - vf.H) / 2;
            if (!hideLab) DrawLabel(c, i, l, s, v, bx, ly);
            int lw = l.Kind == 1 ? 13 : l.Kind == 2 ? l.W : 0;
            if (!p.NoNum) { c.Hush = v.HideNum; num(bx + bw - vw, vy); c.Hush = false; Mark(c, v, bx + bw - vw - mw, vy, vf.H); }
            int x0 = bx + (lw > 0 ? lw + 5 : 0), x1 = p.NoNum ? bx + bw - 1 : bx + bw - Math.Max(vw + mw, nf != null ? nf.ValueW("100", "%") : Fnt.Small.Width("100%")) - 6;   // (number hidden: the bar takes its room)
            DrawBar(c, i, s, v, x0, x1, by + bh / 2, Math.Min(p.NoNum ? 5 : 3, bh));
        }
    }
    static bool solidBar;   // (the theme's bar look, set by Draw)
    static void DrawBar(Cv c, HsInfo i, Src s, Val v, int x0, int x1, int ym, int barH)
    {
        int len = x1 - x0 + 1; if (len < 8) return;
        int top = ym - barH / 2;
        if (solidBar)   // (v3: filled to its share, the rest a dotted line; asleep half lit as the blocks are)
        {
            int pc = v.Empty || v.Off || double.IsNaN(v.V) ? 0 : s.Batt ? (int)v.Frac : (int)Math.Round(Frac(s, v) * 100);
            int fl = (int)Math.Round(len * Math.Max(0, Math.Min(100, pc)) / 100.0);
            if (fl > 0) { c.Tone = v.Sleep ? 1 : 0; c.Block(x0, top, fl, barH); c.Tone = 0; }
            for (int x = x0 + fl + 1; x <= x1; x += 2) c.Set(x, ym);
            return;
        }
        // every reading the same bar (his 11-12 "the bar is different in the sound bar why?? should not be like that"): 8
        // blocks, lit up to its share. A battery's blocks are its 8 steps; charging, the rest light in turn; asleep, half lit
        int n = 8, gap = len >= 60 ? 2 : 1; while (n > 3 && (len + gap) / n - gap < 2) n--;   // (a short bar: fewer blocks, each 2 px at least, the review 11-12)
        int sw = Math.Max(1, (len + gap) / n - gap);
        int segs = v.Empty || v.Off || double.IsNaN(v.V) ? 0 : s.Batt ? HsSt.Segs((int)v.Frac, n) : HsSt.Segs((int)Math.Round(Frac(s, v) * 100), n);
        if (v.Chg && !v.ChgSteady && segs < n) segs += i.Now.Second % (n + 1 - segs);   // (steady: no filling)
        for (int k = 0; k < n; k++)
        {
            int x = x0 + k * (sw + gap);
            if (k < segs) { c.Tone = v.Sleep ? 1 : 0; c.Block(x, top, sw, barH); c.Tone = 0; }
            else c.Set(x + sw / 2, ym);
        }
    }

    // ---- ring (a full circle) and knob (270 degrees, like the base's own knob): the number exactly in the middle ----
    static int Ring(Cv c, HsInfo i, HsPiece p, bool knob, bool measure = false)
    {
        int bx = p.Bx, by = p.By, bw = p.Bw, bh = p.Bh;
        var s = Info(p.Src); var v = Get(i, p); bool on = HsSt.On(i);
        var l = Label(p, s, bw, bh);
        int cap = Cap(p); if (p.Harm > 0) cap = Math.Min(cap, p.Harm);
        if (l.Kind == 2 && l.F == Fnt.Small) { l.F = Fnt.Tiny; l.W = l.F.Width(l.Word); l.H = 5; }
        if (l.Batt) { l.Mini = true; l.W = 11; l.H = 5; }
        bool below = false;   // (inside, under the number, as the knob's: a ring and a knob side by side alike, 11-13)
        int d = below ? Math.Min(bw, bh - l.H - 2) : Math.Min(bw, bh);
        double r = Math.Floor((d - 2) / 2.0);
        if (r < 11) { if (p.NoNum) { if (!measure) LabelOnly(c, i, p); return 0; } if (measure) return -1; p.AsNum = true; Number(c, i, p); return 0; }   // (too small to read: as a number, his 11-12; its number hidden: its label alone, v3)
        int band = r >= 11 ? 2 : 1;
        double rb = r - 5, tb = r >= 18 ? 3 : 2;                                  // (the knob's own band)
        double lim = knob ? rb - tb - 1 : r - band + 0.5 - 1;                     // pixel centres stay inside this (a pixel of air; the knob a little more)
        // the middle: the number, and a slot under it for the label; while charging or asleep the slot shows the bolt or
        // "zZ" every other second instead; an empty spare: its battery dotted, no number
        bool labIn = !below && l.Kind > 0;
        bool hasMark = v.Chg || v.Sleep, showMark = hasMark && (v.ChgSteady || i.Now.Second % 2 == 0);
        var bolt = IconFor("bolt", Ico.Bolt); int mW = v.Chg ? G.W(bolt) : 7, mH = v.Chg ? bolt.Length : 7;
        if (v.Empty) { l = new Lab { Kind = 1, Batt = true, Mini = true, W = 11, H = 5 }; labIn = true; below = false; }
        int sw = labIn ? l.W : 0, sh = labIn ? l.H : 0;
        if (hasMark) { sw = Math.Max(sw, mW); sh = Math.Max(sh, mH); }
        string t = v.Empty || p.NoNum ? "" : v.T, tw = t == "" ? "" : Widest(p, s, v);   // (v3: number hidden, the dial alone)
        // a dial, ring or knob: its number at the exact centre, its label under it (inside a ring; where a knob is
        // open). 11-13: centred together with its label, a number sat higher or lower by its icon's height, and a knob,
        // squeezed inside its track, lost its icon beside rings and pulled the row's digits down to the tiny ones
        bool dial = t != ""; int slotY = 0, gap = 2; NF f;
        if (dial)
        {
            f = DialFit(tw, cap, sw, sh, lim, knob, r, out slotY);   // (the size for the widest value it shows)
            if (f == null && sw > 0 && l.Kind == 2 && !hasMark && l.Word != null && l.Word.Trim().IndexOf(' ') > 0)   // (a name too long for inside the dial: its first word, "CPU" of "CPU TEMPERATURE", before none at all; the tester's F7 11-16)
            {
                var w1 = l.Word.Trim().Split(' ')[0]; l.Word = w1; l.W = l.F.Width(w1); sw = l.W;
                f = DialFit(tw, cap, sw, sh, lim, knob, r, out slotY);
            }
            if (f == null && sw > 0) { sw = sh = 0; labIn = false; hasMark = showMark = false; p.LabCut = l.Kind > 0; f = DialFit(tw, cap, 0, 0, lim, knob, r, out slotY); }
        }
        else f = RingFit(tw, cap, sw, sh, lim, out gap);
        if (f == null && t != "") { if (measure) return -1; p.AsNum = true; Number(c, i, p); return 0; }   // (its number doesn't fit inside: as a number)
        if (measure) return t == "" ? 0 : f.Ht;
        if (dial) { int y2; var fa = DialFit(t, f.Ht, sw, sh, lim, knob, r, out y2); if (fa != null) { f = fa; slotY = y2; } }   // (the value itself: OFF in its letters)
        int nw = t == "" || f == null ? 0 : f.TextW(t), nh = t == "" || f == null ? 0 : f.Ht;
        int h = dial ? nh : nh + (sh > 0 ? (nh > 0 ? gap : 0) + sh : 0);
        // the ring's centre is the number's centre, to the pixel (his "the text inside looks very offcentered")
        int ww = nw > 0 ? nw : sw, nx = bx + (bw - ww) / 2;
        if (p.Align == "left" || p.Align == "right") { double want = p.Align == "left" ? bx + r : bx + bw - 1 - r; nx = (int)Math.Round(want - (ww - 1) / 2.0); }   // (the ring at its box's left or right, 11-13)
        double cx = nx + (ww - 1) / 2.0;
        int areaH = below ? (int)(2 * r + 1) : bh;
        int ty = by + (areaH - h) / 2;
        double cy = ty + (h - 1) / 2.0;
        if (knob && !dial) { cy = by + (bh - 1) / 2.0; ty = (int)Math.Floor(cy - (h - 1) / 2.0) - 1; }
        double a = Frac(s, v);
        if (knob)
        {
            double A = 270 * a;
            c.RingDots(cx, cy, r - 0.5, 225, 495, 27, 0, 2);                    // a tick every 10%
            c.RingDots(cx, cy, rb - (tb - 1) / 2.0, 225, 495, Math.Max(5, 360 / (rb * 1.2)), 0, 1);   // the track
            if (A > 0) c.Band(cx, cy, rb, tb, 225, 225 + A);
        }
        else
        {
            double A = 360 * a, step = r >= 11 ? 15 : 30, mid = r - (band - 1) / 2.0;
            double from = Math.Ceiling((A + 1) / step) * step + (v.Chg ? (i.Now.Second % 3) * step / 3 : 0);
            c.RingDots(cx, cy, mid, from, 359.9, step, 0, 1);
            if (A > 0 && !(v.Low && !on)) { if (v.Sleep) c.Band(cx, cy, r, 1, 0, A); else c.Band(cx, cy, r, band, 0, A); }
        }
        if (nw > 0) { c.Hush = v.HideNum; f.Text(c, nx, ty, t); c.Hush = false; }
        int sy = dial ? (int)Math.Floor(cy + 0.5) + slotY : ty + (nh > 0 ? nh + gap : 0);
        if (showMark) { int mx = (int)Math.Floor(cx - (mW - 1) / 2.0 + 0.5), my = sy + (sh - mH) / 2; if (v.Chg) c.Bmp(mx, my, bolt); else G.Zz(c, mx, my); }
        else if (labIn) DrawLabel(c, i, l, s, v, (int)Math.Floor(cx - (l.W - 1) / 2.0 + 0.5), sy + (sh - l.H) / 2);
        if (below) DrawLabel(c, i, l, s, v, (int)Math.Round(cx - (l.W - 1) / 2.0), by + (int)(2 * r + 1) + 2);
        return f == null ? 0 : f.Ht;
    }
    // a dial's middle: the number (t) at the centre, its slot (sw x sh, 0: none) 2 px under it (1 if that keeps the number's size), inside a ring, or where
    // a knob is open at its bottom (no wider than the opening there, above its rim). The biggest number that leaves
    // the slot its room; slotY: the slot's top, in rows under the centre
    static NF DialFit(string t, int cap, int sw, int sh, double lim, bool knob, double r, out int slotY)
    {
        slotY = 0;
        foreach (var cand in NF.All(BigOk(t)))
        {
            if (cand.Ht > cap) continue;
            double xn = (cand.TextW(t) - 1) / 2.0, yn = (cand.Ht - 1) / 2.0;
            if (Math.Sqrt(xn * xn + yn * yn) > lim) continue;
            if (sh == 0) return cand;
            for (int g = 2; g >= 1; g--)   // (a 1 px gap before a smaller number)
            {
                int y0 = Math.Max((cand.Ht + 1) / 2 + g, knob ? sw / 2 + 2 : 0); double xs = (sw - 1) / 2.0, yb = y0 + sh - 0.5;
                if (knob ? yb <= r - 1 : Math.Sqrt(xs * xs + yb * yb) <= lim) { slotY = y0; return cand; }
            }
        }
        return null;
    }
    // the biggest number (t, "" none) that fits inside with its slot under it; a 1 px gap before a smaller number
    static NF RingFit(string t, int cap, int sw, int sh, double lim, out int gap)
    {
        gap = 2;
        foreach (var cand in NF.All(BigOk(t))) { if (cand.Ht > cap) continue; for (int g = 2; g >= 1; g--) if (Fits(t == "" ? 0 : cand.TextW(t), t == "" ? 0 : cand.Ht, sw, sh, g, lim)) { gap = g; return cand; } }
        return null;
    }
    // a number (nw x nh) and a slot under it (sw x sh), centred together: every corner pixel's centre within lim of the middle
    static bool Fits(int nw, int nh, int sw, int sh, int gap, double lim)
    {
        int h = nh + (sh > 0 ? (nh > 0 ? gap : 0) + sh : 0);
        double top = -(h - 1) / 2.0;
        Func<double, double, double> D = (x, y) => Math.Sqrt(x * x + y * y);
        if (nh > 0) { double xn = (nw - 1) / 2.0; if (D(xn, top) > lim || D(xn, top + nh - 1) > lim) return false; }
        if (sh > 0) { double y0 = top + (nh > 0 ? nh + gap : 0), xs = (sw - 1) / 2.0; if (D(xs, y0) > lim || D(xs, y0 + sh - 1) > lim) return false; }
        return true;
    }

    // ---- graph: the last minutes as a line, a smoothed line, steps, a filled area, bars or dots, the value on top; a
    // second reading dotted; its low and high his own or from what it shows ----
    static void Graph(Cv c, HsInfo i, HsPiece p)
    {
        int bx = p.Bx, by = p.By, bw = p.Bw, bh = p.Bh;
        var s = Info(p.Src); var v = Get(i, p);
        var F = p.Size == "s" ? Fnt.Tiny : p.Size == "l" ? (bh >= 14 ? Fnt.Small : Fnt.Tiny) : bh >= 26 ? Fnt.Small : Fnt.Tiny;
        string t1 = ((p.Label == "off" ? "" : (p.Name ?? s.Name) + " ") + (p.NoNum ? "" : v.T + v.U)).Trim();   // (v3: number hidden, the name alone)
        string t2 = null;
        if (p.Src2 != null)
        {
            var s2 = Info(p.Src2); var v2 = Get(i, p, p.Src2);
            t2 = ((p.Label == "off" ? "" : s2.Name + " ") + (p.NoNum ? "" : v2.T + v2.U)).Trim();
            // (11-14 release checks: in a narrow place the two were drawn over each other: the names go first, then the second)
            if (8 + F.Width(t1) + 10 + F.Width(t2) > bw && !p.NoNum) { t1 = (v.T + v.U).Trim(); t2 = (v2.T + v2.U).Trim(); }
            if (8 + F.Width(t1) + 10 + F.Width(t2) > bw) t2 = null;
        }
        int x = bx;
        if (p.Src2 != null) { c.HLine(x, x + 4, by + F.H / 2); x += 8; }
        if (x + F.Width(t1) > bx + bw && !p.NoNum) t1 = (v.T + v.U).Trim();   // (alone and still too wide: its number, else nothing past its place)
        if (x + F.Width(t1) > bx + bw) t1 = "";
        c.Hush = v.HideNum || v.HideIco; F.Draw(c, x, by, t1); c.Hush = false;   // (a battery's low blink: its name and number are one text here)
        if (t2 != null)
        {
            int x2 = bx + bw - F.Width(t2);
            F.Draw(c, x2, by, t2);
            for (int k = x2 - 8; k <= x2 - 3; k += 2) c.Set(k, by + F.H / 2);
        }
        int gy0 = by + F.H + 3, gy1 = by + bh - 1;
        if (gy1 - gy0 < 4) return;
        var a = Series(p.Src, p.Over, bw);
        var b = p.Src2 != null ? Series(p.Src2, p.Over, bw) : null;
        double lo = double.MaxValue, hi = double.MinValue;
        foreach (var arr in new[] { a, b }) if (arr != null) foreach (double d in arr) if (!double.IsNaN(d)) { lo = Math.Min(lo, d); hi = Math.Max(hi, d); }
        if (hi < lo) return;
        double span = Math.Max(s.Span, (hi - lo) * 1.15), m = (hi + lo) / 2; lo = m - span / 2; hi = m + span / 2;
        double flo = double.IsNaN(p.Lo) ? lo : p.Lo, fhi = double.IsNaN(p.Hi) ? hi : p.Hi;   // (his own low / high, 11-13)
        if (!double.IsNaN(p.Lo) && double.IsNaN(p.Hi) && fhi <= flo) fhi = flo + span;
        if (double.IsNaN(p.Lo) && !double.IsNaN(p.Hi) && fhi <= flo) flo = fhi - span;
        if (fhi > flo) { lo = flo; hi = fhi; }
        Func<double, int> Y = d => Math.Max(gy0, Math.Min(gy1, gy1 - (int)Math.Round((d - lo) / (hi - lo) * (gy1 - gy0))));
        string kind = p.Graph;
        if (kind == "smooth") a = Smooth(a, 3);
        if (kind == "steps")
        {
            const int step = 4; int py = -1;   // (4 px a step: a value held, then a jump)
            for (int k0 = 0; k0 < bw; k0 += step)
            {
                int k1 = Math.Min(bw - 1, k0 + step - 1); double sum = 0; int cnt = 0;
                for (int k = k0; k <= k1; k++) if (!double.IsNaN(a[k])) { sum += a[k]; cnt++; }
                if (cnt == 0) { py = -1; continue; }
                int y = Y(sum / cnt);
                if (py >= 0) c.VLine(bx + k0, Math.Min(py, y), Math.Max(py, y));
                c.HLine(bx + k0, bx + k1, y); py = y;
            }
        }
        else
            for (int k = 0; k < bw; k++)
            {
                if (double.IsNaN(a[k])) continue;
                int y = Y(a[k]);
                if (kind == "bars") { if (k % 2 == 0) c.VLine(bx + k, y, gy1); }
                else if (kind == "dots") c.Set(bx + k, y);
                else
                {
                    if (k > 0 && !double.IsNaN(a[k - 1])) c.Line(bx + k - 1, Y(a[k - 1]), bx + k, y, 1); else c.Set(bx + k, y);
                    if (kind == "area" && y < gy1) { c.Tone = 1; c.VLine(bx + k, y + 1, gy1); c.Tone = 0; }   // (under the line: every other pixel)
                }
            }
        if (b != null) for (int k = 0; k < bw; k += 2) if (!double.IsNaN(b[k])) c.Set(bx + k, Y(b[k]));
    }
    // each column the mean of its neighbours within n (its gaps stay gaps)
    static double[] Smooth(double[] a, int n)
    {
        var r = new double[a.Length];
        for (int k = 0; k < a.Length; k++)
        {
            if (double.IsNaN(a[k])) { r[k] = double.NaN; continue; }
            double sum = 0; int cnt = 0;
            for (int j = Math.Max(0, k - n); j <= Math.Min(a.Length - 1, k + n); j++) if (!double.IsNaN(a[j])) { sum += a[j]; cnt++; }
            r[k] = sum / cnt;
        }
        return r;
    }
    // n columns across the last `over` seconds, each the mean of its seconds (oldest first)
    static double[] Series(string key, int over, int n)
    {
        var res = new double[n]; double[] h;
        if (!Hist.TryGetValue(key, out h)) { for (int k = 0; k < n; k++) res[k] = double.NaN; return res; }
        double per = over / (double)n;
        for (int k = 0; k < n; k++)
        {
            double t0 = (n - k) * per, t1 = (n - k - 1) * per;   // seconds ago, from .. to
            int i0 = h.Length - 1 - (int)Math.Floor(t1), i1 = h.Length - 1 - (int)Math.Ceiling(t0 - 1);
            double sum = 0; int cnt = 0;
            for (int j = Math.Max(0, Math.Min(i0, i1)); j <= Math.Min(h.Length - 1, Math.Max(i0, i1)); j++) if (!double.IsNaN(h[j])) { sum += h[j]; cnt++; }
            res[k] = cnt > 0 ? sum / cnt : double.NaN;
        }
        return res;
    }

    // ---- clock: hours and minutes as big as the box allows, seconds small, the day under ----
    // (11-17 his "it shouldn't allow if it doesnt fit, or just try to fit": a clock in a cell too small for all of it drew
    // nothing. It tries as set, then without the date, then without the seconds (and AM / PM), then without its label; the
    // editor is told what it left out. And its own settings as a number cell's: label, 12 hours, the date beside or under,
    // the date's words)
    static string ClockDate(DateTime t, string fmt)
    {
        var ic = CultureInfo.InvariantCulture;
        string s = fmt == "short" ? t.ToString("d MMM", ic) : fmt == "num" ? t.ToString("dd/MM", ic) : fmt == "wday" ? t.ToString("ddd", ic) : t.ToString("ddd d MMM", ic);
        return s.ToUpperInvariant();
    }
    static void Clock(Cv c, HsInfo i, HsPiece p)
    {
        var ic = CultureInfo.InvariantCulture;
        string hh = p.H12 ? i.Now.ToString("%h", ic) : i.Now.ToString("HH", ic), mm = i.Now.ToString("mm", ic), ss = i.Now.ToString("ss", ic);
        string ap = p.H12 ? (i.Now.Hour < 12 ? "AM" : "PM") : null, date = p.Date ? ClockDate(i.Now, p.DateFmt) : null;
        var src = new Src { Key = "clock", Name = "TIME", Icon = IconFor("clock", Ico.Clock) };
        var lab = Label(p, src, p.Bw, p.Bh);
        for (int t = 0; t < 4; t++)
        {
            bool wD = date != null && t < 1, wS = (p.Seconds || ap != null) && t < 2, wL = lab.Kind > 0 && t < 3;
            if (t > 0 && wD == (date != null && t - 1 < 1) && wS == ((p.Seconds || ap != null) && t - 1 < 2) && wL == (lab.Kind > 0 && t - 1 < 3)) continue;   // (nothing new left out at this step)
            if (ClockAt(c, i, p, hh, mm, wS && p.Seconds ? ss : null, wS ? ap : null, wD ? date : null, wL ? lab : null, src))
            { p.DateCut = date != null && !wD; p.SecCut = (p.Seconds || ap != null) && !wS; p.LabCut = lab.Kind > 0 && !wL; return; }
        }
        p.DateCut = date != null; p.SecCut = p.Seconds || ap != null; p.LabCut = lab.Kind > 0;   // (not even the time fits: nothing drawn, all of it said)
    }
    static bool ClockAt(Cv c, HsInfo i, HsPiece p, string hh, string mm, string ss, string ap, string date, Lab lab, Src src)
    {
        int bx = p.Bx, by = p.By, bw = p.Bw, bh = p.Bh;
        bool beside = date != null && p.DateAt == "beside";
        var df = date != null && !beside && bh >= 44 ? Fnt.Small : Fnt.Tiny;
        int dh = date != null && !beside ? df.H + 3 : 0, lw = lab != null ? lab.W + 3 : 0;
        if (date != null && !beside && df.Width(date) > bw) return false;   // (the date under, wider than the cell at any size)
        if (lab != null && lab.H > bh) return false;
        int cap = Cap(p);
        foreach (var f in NF.All(true))
        {
            if (f.Ht > cap && f.K != 2) continue;   // (his text size; the tiny font always, as the last resort)
            int colon = f.K == 0 ? f.T : 1, cg = f.K == 0 ? f.T + 1 : 1, sgap = f.K == 0 ? f.T + 2 : 2;
            var sf = f.K == 0 && f.H >= 22 ? Fnt.Small : Fnt.Tiny;
            int w = f.TextW(hh) + cg + colon + cg + f.TextW(mm), sw = (ss != null ? sgap + sf.Width(ss) : 0) + (ap != null ? sgap + sf.Width(ap) : 0), dw = beside ? 4 + df.Width(date) : 0;
            int all = lw + w + sw + dw;
            if (f.Ht + dh > bh || all > bw) continue;
            int x = p.Align == "left" ? bx : p.Align == "right" ? bx + bw - all : bx + (bw - all) / 2, y = by + (bh - f.Ht - dh) / 2, x0 = x;
            if (lab != null) { DrawLabel(c, i, lab, src, new Val(), x, y + (f.Ht - lab.H) / 2); x += lw; }
            f.Text(c, x, y, hh); x += f.TextW(hh) + cg;
            if (f.K == 0) { c.Block(x, y + f.H * 3 / 10, colon, colon); c.Block(x, y + f.H * 7 / 10 - colon + 1, colon, colon); }
            else (f.K == 1 ? Fnt.Small : Fnt.Tiny).Draw(c, x, y, ":");
            x += colon + cg;
            f.Text(c, x, y, mm); x += f.TextW(mm);
            if (ss != null) { sf.Draw(c, x + sgap, y + f.Ht - sf.H, ss); x += sgap + sf.Width(ss); }
            if (ap != null) { sf.Draw(c, x + sgap, y + f.Ht - sf.H, ap); x += sgap + sf.Width(ap); }
            if (beside) df.Draw(c, x + 4, y + f.Ht - df.H, date);
            else if (date != null) { int dw2 = df.Width(date); df.Draw(c, p.Align == "left" ? bx : p.Align == "right" ? bx + bw - dw2 : bx + (bw - dw2) / 2, y + f.Ht + 3, date); }
            return true;
        }
        return false;
    }
}

// anim.cs: start up / shut down animations for the headset base station's screen (128 x 64, one bit a pixel, OLED).
// Time based: the player asks for the picture at t milliseconds, so it plays at whatever rate the base takes
// (somewhere between 10 and 30 pictures a second; the real top rate is not measured yet).
// Each animation is one class in its own file anim-<key>.cs, named Anim_<key>, everything it needs nested inside it.
abstract class HsAnim
{
    public abstract string Key { get; }       // short id, lower case, as in its file name
    public abstract string Name { get; }      // the picker's name under its card: one or two plain words ("Old TV")
    public abstract int StartMs { get; }      // 600 to 1500
    public abstract int StopMs { get; }       // 300 to 800
    // from black to the page; Start(StartMs, page) must be exactly the page. page: [x, y], true = lit, 128 x 64.
    public abstract bool[,] Start(double t, bool[,] page);
    // from the page to black; Stop(StopMs, page) must be all black.
    public abstract bool[,] Stop(double t, bool[,] page);
}

// anim-tv.cs: an old CRT television. Start: a dot in the middle grows into a thin line, the line opens into the page.
// Stop: the page squeezes into a bright line, the line shrinks to a dot, the dot dies away to one pixel, then black.

class Anim_tv : HsAnim
{
    public override string Key { get { return "tv"; } }
    public override string Name { get { return "Old TV"; } }
    public override int StartMs { get { return 1150; } }
    public override int StopMs { get { return 650; } }

    // start timeline (ms)
    const double S_DOT = 110, S_BLOOM = 220, S_LINE = 520, S_END = 1150;
    // stop timeline (ms)
    const double P_SQUEEZE = 290, P_LINE = 430, P_DOT = 540, P_END = 650;

    static readonly int[,] Bayer = {
        { 0, 8, 2, 10 }, { 12, 4, 14, 6 }, { 3, 11, 1, 9 }, { 15, 7, 13, 5 } };

    public override bool[,] Start(double t, bool[,] page)
    {
        if (t >= S_END) return (bool[,])page.Clone();
        t = Math.Max(0, t);
        var o = new bool[128, 64];
        if (t < S_DOT) { Rect(o, 63, 31, 2, 2); return o; }
        if (t < S_BLOOM) { Round(o); return o; }
        if (t < S_LINE)
        {
            double k = EaseInOut((t - S_BLOOM) / (S_LINE - S_BLOOM));
            Line(o, 4 + k * 124);
            return o;
        }
        double u = (t - S_LINE) / (S_END - S_LINE);
        double h = 2 + EaseInOut(u) * 62;
        // the bright edges stay strong while it opens, then dissolve over the last stretch
        double edge = 1 - Smooth((u - 0.72) / 0.28);
        Band(o, page, h, edge);
        return o;
    }

    public override bool[,] Stop(double t, bool[,] page)
    {
        var o = new bool[128, 64];
        if (t >= P_END) return o;
        t = Math.Max(0, t);
        if (t < P_SQUEEZE)
        {
            double u = t / P_SQUEEZE;
            double h = 64 - EaseInStrong(u) * 62;
            double edge = Smooth(u / 0.3);
            Band(o, page, h, edge);
            return o;
        }
        if (t < P_LINE)
        {
            double k = EaseInOut((t - P_SQUEEZE) / (P_LINE - P_SQUEEZE));
            Line(o, 128 - k * 126);
            return o;
        }
        if (t < P_DOT) { Rect(o, 63, 31, 2, 2); return o; }
        o[63, 31] = true;
        return o;
    }

    // the page squeezed vertically into a centred band h rows tall; each band row ORs the page rows it covers,
    // so a thin band glows bright like a collapsed picture. edge (0..1) lights the top and bottom rows of the band.
    static void Band(bool[,] o, bool[,] page, double h, double edge)
    {
        int top = (int)Math.Round(32 - h / 2);
        top = Math.Max(0, Math.Min(31, top));
        int bot = 64 - top;              // exclusive, symmetric about the middle
        int rows = bot - top;
        for (int y = top; y < bot; y++)
        {
            int s0 = (int)Math.Floor((double)(y - top) * 64 / rows);
            int s1 = (int)Math.Ceiling((double)(y - top + 1) * 64 / rows);
            s1 = Math.Min(64, Math.Max(s0 + 1, s1));
            for (int x = 0; x < 128; x++)
            {
                bool v = false;
                for (int s = s0; s < s1 && !v; s++) v = page[x, s];
                o[x, y] = v;
            }
        }
        if (edge <= 0) return;
        int lvl = (int)Math.Round(edge * 16);
        for (int x = 0; x < 128; x++)
        {
            if (Bayer[x & 3, top & 3] < lvl) o[x, top] = true;
            if (Bayer[x & 3, (bot - 1) & 3] < lvl) o[x, bot - 1] = true;
        }
    }

    // a 2 row line centred on the screen, w pixels wide (kept even so it stays centred)
    static void Line(bool[,] o, double w)
    {
        int half = Math.Max(1, Math.Min(64, (int)Math.Round(w / 2)));
        Rect(o, 64 - half, 31, half * 2, 2);
    }

    // a small round 4 x 4 bloom around the centre dot
    static void Round(bool[,] o)
    {
        Rect(o, 62, 31, 4, 2);
        Rect(o, 63, 30, 2, 4);
    }

    static void Rect(bool[,] o, int x, int y, int w, int h)
    {
        for (int i = Math.Max(0, x); i < Math.Min(128, x + w); i++)
            for (int j = Math.Max(0, y); j < Math.Min(64, y + h); j++)
                o[i, j] = true;
    }

    static double Clamp01(double u) { return Math.Max(0, Math.Min(1, u)); }
    static double Smooth(double u) { u = Clamp01(u); return u * u * (3 - 2 * u); }
    static double EaseInOut(double u) { u = Clamp01(u); return u * u * u * (u * (u * 6 - 15) + 10); }
    // starts gently, then accelerates into the line (the picture collapsing)
    static double EaseInStrong(double u) { u = Clamp01(u); return 0.5 * (u * u * u) + 0.5 * Smooth(u); }
}

// anim-scan.cs: a scanline. Start: a short line opens at the top centre, then sweeps down with a dithered glow
// trailing above it, laying the page down behind it. Stop: the line rises from the bottom, wiping the page away with
// the glow trailing below it, and closes to a point at the top centre.

class Anim_scan : HsAnim
{
    public override string Key { get { return "scan"; } }
    public override string Name { get { return "Scan"; } }
    public override int StartMs { get { return 1000; } }
    public override int StopMs { get { return 600; } }

    const int Trail = 7;        // rows of dithered glow behind the line
    const double OpenMs = 160;  // start: the line opens from the centre
    const double CloseMs = 170; // stop: the line closes to the centre

    static readonly int[,] Bayer = {
        { 0, 8, 2, 10 }, { 12, 4, 14, 6 }, { 3, 11, 1, 9 }, { 15, 7, 13, 5 } };

    // glow density at distance d (1..Trail) behind the line, 0..1
    static double Glow(int d)
    {
        double u = 1.0 - (double)d / (Trail + 1);
        return u * u * 0.85;
    }

    static bool Dot(int x, int y, double density)
    {
        return (Bayer[y & 3, x & 3] + 0.5) / 16.0 < density;
    }

    static double InOut(double u) { u = Math.Max(0, Math.Min(1, u)); return 0.3 * u + 0.7 * (0.5 - 0.5 * Math.Cos(Math.PI * u)); }
    static double Out(double u) { u = Math.Max(0, Math.Min(1, u)); return 1 - Math.Pow(1 - u, 3); }
    static double In(double u) { u = Math.Max(0, Math.Min(1, u)); return u * u * u; }

    // draws a horizontal line centred at x 64 with half width hw on row y
    static void Line(bool[,] o, int y, double hw)
    {
        if (y < 0 || y > 63) return;
        int a = (int)Math.Round(64 - hw), b = (int)Math.Round(64 + hw);
        for (int x = Math.Max(0, a); x < Math.Min(128, b); x++) o[x, y] = true;
    }

    public override bool[,] Start(double t, bool[,] page)
    {
        var o = new bool[128, 64];
        t = Math.Max(0, t);
        if (t >= StartMs) return (bool[,])page.Clone();
        if (t < OpenMs)
        {
            Line(o, 0, 64 * Out(t / OpenMs));
            return o;
        }
        // line row goes from 0 to 64 + Trail (fully off the bottom, trail included)
        double k = InOut((t - OpenMs) / (StartMs - OpenMs));
        int ly = (int)Math.Round(k * (64 + Trail));
        for (int y = 0; y < 64; y++)
        {
            if (y >= ly) continue;
            int d = ly - y;
            double g = d <= Trail ? Glow(d) : 0;
            for (int x = 0; x < 128; x++)
                o[x, y] = page[x, y] || (g > 0 && Dot(x, y, g));
        }
        Line(o, ly, 64);
        return o;
    }

    public override bool[,] Stop(double t, bool[,] page)
    {
        var o = new bool[128, 64];
        t = Math.Max(0, t);
        if (t >= StopMs) return o;
        double sweepMs = StopMs - CloseMs;
        int ly; double fade = 1, hw = 64;
        if (t < sweepMs)
        {
            ly = 63 - (int)Math.Round(InOut(t / sweepMs) * 63);
        }
        else
        {
            ly = 0;
            double c = (t - sweepMs) / CloseMs;
            hw = 64 * (1 - In(c));
            fade = 1 - Out(c);
        }
        for (int y = 0; y < 64; y++)
        {
            if (y < ly) { for (int x = 0; x < 128; x++) o[x, y] = page[x, y]; continue; }
            int d = y - ly;
            if (d < 1 || d > Trail) continue;
            double g = Glow(d) * fade;
            for (int x = 0; x < 128; x++) o[x, y] = Dot(x, y, g);
        }
        Line(o, ly, hw);
        return o;
    }
}

// anim-fade.cs: a real fade on a one-bit screen. The page's lit pixels come and go in the order of an 8 x 8 Bayer
// threshold, so the share of lit pixels (what the eye reads as brightness) rises and falls smoothly.

class Anim_fade : HsAnim
{
    public override string Key { get { return "fade"; } }
    public override string Name { get { return "Fade"; } }
    public override int StartMs { get { return 1100; } }
    public override int StopMs { get { return 550; } }

    // classic 8 x 8 ordered dither matrix, values 0..63
    static readonly int[,] Bayer = MakeBayer();

    static int[,] MakeBayer()
    {
        int[] r = {
             0, 32,  8, 40,  2, 34, 10, 42,
            48, 16, 56, 24, 50, 18, 58, 26,
            12, 44,  4, 36, 14, 46,  6, 38,
            60, 28, 52, 20, 62, 30, 54, 22,
             3, 35, 11, 43,  1, 33,  9, 41,
            51, 19, 59, 27, 49, 17, 57, 25,
            15, 47,  7, 39, 13, 45,  5, 37,
            63, 31, 55, 23, 61, 29, 53, 21 };
        var m = new int[8, 8];
        for (int y = 0; y < 8; y++)
            for (int x = 0; x < 8; x++)
                m[x, y] = r[y * 8 + x];
        return m;
    }

    // from black: the page first glows up as a soft dithered haze around its shapes, then the haze
    // gathers into the sharp page while the brightness keeps rising
    public override bool[,] Start(double t, bool[,] page)
    {
        if (t >= StartMs) return (bool[,])page.Clone();
        double u = Math.Max(0, t) / StartMs;
        double level = Smooth(u / 0.75);
        double focus = Ease((u - 0.25) / 0.75);
        return Field(page, level, focus);
    }

    // to black: the same in reverse and quicker, the page softens into its haze and dims away
    public override bool[,] Stop(double t, bool[,] page)
    {
        if (t >= StopMs) return new bool[128, 64];
        double u = Math.Max(0, t) / StopMs;
        double level = 1 - Smooth(u / 0.92);
        double focus = 1 - Ease(u / 0.7);
        return Field(page, level, focus);
    }

    // brightness of each pixel = level * mix(haze, page, focus), shown through the Bayer threshold
    static bool[,] Field(bool[,] page, double level, double focus)
    {
        var o = new bool[128, 64];
        if (level <= 0) return o;
        double[,] haze = Haze(page);
        for (int x = 0; x < 128; x++)
            for (int y = 0; y < 64; y++)
            {
                double p = page[x, y] ? 1.0 : 0.0;
                double v = level * ((1 - focus) * haze[x, y] + focus * p);
                o[x, y] = (Bayer[x & 7, y & 7] + 0.5) / 64.0 < v;
            }
        return o;
    }

    // a soft glow of the page: a 5 x 5 box average, lifted so thin lines still make a visible haze
    static double[,] Haze(bool[,] page)
    {
        const int R = 2;
        const double Gain = 2.2;
        const double Peak = 0.7;   // the haze stays dimmer than the page, so the sharp shapes stand out as it gathers
        var sat = new int[129, 65];
        for (int x = 0; x < 128; x++)
            for (int y = 0; y < 64; y++)
                sat[x + 1, y + 1] = (page[x, y] ? 1 : 0) + sat[x, y + 1] + sat[x + 1, y] - sat[x, y];
        var h = new double[128, 64];
        for (int x = 0; x < 128; x++)
            for (int y = 0; y < 64; y++)
            {
                int x0 = Math.Max(0, x - R), x1 = Math.Min(128, x + R + 1);
                int y0 = Math.Max(0, y - R), y1 = Math.Min(64, y + R + 1);
                int s = sat[x1, y1] - sat[x0, y1] - sat[x1, y0] + sat[x0, y0];
                h[x, y] = Peak * Math.Min(1.0, Gain * s / 25.0);
            }
        return h;
    }

    static double Smooth(double u)
    {
        u = Math.Max(0, Math.Min(1, u));
        return u * u * (3 - 2 * u);
    }

    static double Ease(double u)
    {
        u = Math.Max(0, Math.Min(1, u));
        return u * u * u * (u * (u * 6 - 15) + 10);
    }
}

// anim-sand.cs: falling sand. Start: every lit pixel of the page drops in from above the screen and lands
// on its spot, the middle columns first and spreading out, the lowest grains of each column landing first so
// the page piles up from the bottom. Stop: the same grains fall away through the bottom edge, lowest first.

class Anim_sand : HsAnim
{
    public override string Key { get { return "sand"; } }
    public override string Name { get { return "Sand"; } }
    public override int StartMs { get { return 950; } }
    public override int StopMs { get { return 650; } }

    // start timing (ms)
    const double S_COL = 380;   // middle column to edge column delay
    const double S_ROW = 300;   // bottom row to top row delay
    const double S_JIT = 70;    // per grain jitter
    const double S_FALL = 560;  // time to fall
    const double S_LEAD = 110;  // ms of the timeline skipped at the start (nothing on screen yet)
    const double S_DROP = 67;   // full screen height plus the start gap, for the fall time

    // stop timing (ms)
    const double E_COL = 90;
    const double E_ROW = 170;
    const double E_JIT = 45;
    const double E_FALL = 330;
    const double E_DROP = 70;

    public override bool[,] Start(double t, bool[,] page)
    {
        if (t >= StartMs) return (bool[,])page.Clone();
        t = Math.Max(0, t) + S_LEAD;   // skip the first moments, where every grain is still above the screen
        var o = new bool[128, 64];
        for (int x = 0; x < 128; x++)
        {
            double cd = Math.Abs(x - 63.5) / 63.5;
            cd = cd * cd * 0.35 + cd * 0.65;            // a soft spread from the middle
            for (int y = 0; y < 64; y++)
            {
                if (!page[x, y]) continue;
                double d = cd * S_COL + (63 - y) / 63.0 * S_ROW + Jit(x, y) * S_JIT;
                // each grain starts just above the screen, so the fall time follows real gravity (sqrt of height)
                double drop = y + 4;
                double u = (t - d) / (S_FALL * Math.Sqrt(drop / S_DROP));
                if (u <= 0) continue;
                if (u >= 1) { o[x, y] = true; continue; }
                // gravity: starts slow, lands fast, with a gentle last stretch so it does not snap
                double k = Fall(u);
                int py = (int)Math.Round(y - drop * (1 - k));
                if (py >= 0 && py < 64) o[x, py] = true;
            }
        }
        return o;
    }

    public override bool[,] Stop(double t, bool[,] page)
    {
        var o = new bool[128, 64];
        if (t >= StopMs) return o;
        t = Math.Max(0, t);
        for (int x = 0; x < 128; x++)
        {
            double cd = Math.Abs(x - 63.5) / 63.5;
            cd = cd * cd * 0.35 + cd * 0.65;
            for (int y = 0; y < 64; y++)
            {
                if (!page[x, y]) continue;
                double d = cd * E_COL + (63 - y) / 63.0 * E_ROW + Jit(x, y) * E_JIT;
                double u = (t - d) / E_FALL;
                if (u <= 0) { o[x, y] = true; continue; }
                if (u >= 1) continue;
                int py = (int)Math.Round(y + E_DROP * u * u);
                if (py >= 0 && py < 64) o[x, py] = true;
            }
        }
        return o;
    }

    // accelerating fall, eased into the landing over the last few pixels
    static double Fall(double u)
    {
        // quadratic fall, then a short cubic ease into the spot (continuous slope at the join)
        const double a = 0.82;              // where the ease takes over
        double ya = a * a;                   // position at the join (of 1 total, before scaling)
        double va = 2 * a;                   // speed at the join
        double total = ya + va * (1 - a) * 0.5; // end position when slowing linearly to zero
        if (u <= a) return (u * u) / total;
        double s = u - a, L = 1 - a;
        double p = ya + va * (s - s * s / (2 * L));
        return p / total;
    }

    // fixed per grain jitter 0..1
    static double Jit(int x, int y)
    {
        unchecked
        {
            uint h = (uint)(x * 374761393 + y * 668265263);
            h = (h ^ (h >> 13)) * 1274126177u;
            h ^= h >> 16;
            return (h & 0xFFFF) / 65535.0;
        }
    }
}

// anim-iris.cs: a camera iris. Start: a lit point in the middle opens into a circle showing the page,
// a 1 px lit ring on its edge, until the ring leaves the screen. Stop: the same circle closes to the point and it goes out.

class Anim_iris : HsAnim
{
    public override string Key { get { return "iris"; } }
    public override string Name { get { return "Iris"; } }
    public override int StartMs { get { return 920; } }
    public override int StopMs { get { return 560; } }

    const double CX = 63.5, CY = 31.5;
    const double RMAX = 74.0;      // ring fully past the corners (corner distance is about 71.6)
    const double RDOT = 1.25;      // the 2 x 2 point in the middle
    const double DOT_MS = 110;    // how long the point holds (lives over a frame even at 10 a second)

    public override bool[,] Start(double t, bool[,] page)
    {
        t = Math.Max(0, t);
        if (t >= StartMs) return (bool[,])page.Clone();
        double r;
        if (t < DOT_MS) r = RDOT;
        else
        {
            double u = (t - DOT_MS) / (StartMs - DOT_MS);
            r = RDOT + (RMAX - RDOT) * EaseInOut(u);
        }
        return Draw(r, page);
    }

    public override bool[,] Stop(double t, bool[,] page)
    {
        t = Math.Max(0, t);
        if (t >= StopMs) return new bool[128, 64];
        double shrink = StopMs - DOT_MS;
        double r;
        if (t < shrink)
        {
            double u = t / shrink;
            r = RMAX - (RMAX - RDOT) * EaseInOutQuick(u);
        }
        else r = RDOT;
        return Draw(r, page);
    }

    // inside: the page; a 1 px black gap just inside the ring so the ring reads against busy page parts; the ring; outside black
    private static bool[,] Draw(double r, bool[,] page)
    {
        var o = new bool[128, 64];
        double ringIn = r - 1.0, gapIn = r - 2.0;
        for (int x = 0; x < 128; x++)
        {
            double dx = x - CX;
            for (int y = 0; y < 64; y++)
            {
                double dy = y - CY;
                double d = Math.Sqrt(dx * dx + dy * dy);
                if (d >= r) continue;
                if (d >= ringIn) o[x, y] = true;
                else if (d >= gapIn) o[x, y] = false;
                else o[x, y] = page[x, y];
            }
        }
        return o;
    }

    // cubic in and out: starts gently, glides, settles softly
    private static double EaseInOut(double u)
    {
        u = Math.Max(0, Math.Min(1, u));
        double io = u < 0.5 ? 4 * u * u * u : 1 - Math.Pow(-2 * u + 2, 3) / 2;
        double o = 1 - Math.Pow(1 - u, 3);
        return 0.6 * io + 0.4 * o;
    }

    // for the stop: leaves the edges a little faster than it arrives in the middle (decisive, still soft at the point)
    private static double EaseInOutQuick(double u)
    {
        u = Math.Max(0, Math.Min(1, u));
        return Blend(u);
    }

    private static double Blend(double u)
    {
        // smoother step with a slightly earlier middle: fast through the large radii, soft landing on the point
        double s = u * u * u * (u * (u * 6 - 15) + 10);
        double e = 1 - Math.Pow(1 - u, 3);
        return 0.5 * s + 0.5 * e;
    }
}

// anim-blinds.cs: venetian blinds. The screen is eight strips of 8 px.
// Start: from the top down, each strip shows a thin lit line on its centre, the line splits into two edges
// that glide apart, and the page appears between them until the strip is fully open.
// Stop: the same strips close from the bottom up, the edges glide back together into a centre line,
// and the lines go out one after another.

class Anim_blinds : HsAnim
{
    public override string Key { get { return "blinds"; } }
    public override string Name { get { return "Blinds"; } }
    public override int StartMs { get { return 1100; } }
    public override int StopMs { get { return 600; } }

    const int StripH = 8;
    const int Strips = 64 / StripH;
    const double HMin = -1.0;          // below 0 the strip is a centre line only
    const double HMax = StripH / 2.0;  // fully open

    // start: per strip timing, top strip first
    const double StartStrip = 560;
    const double StopStrip = 380;

    public override bool[,] Start(double t, bool[,] page)
    {
        if (t >= StartMs) return (bool[,])page.Clone();
        t = Math.Max(0, t);
        double stagger = (StartMs - StartStrip) / (Strips - 1);
        var h = new double[Strips];
        var on = new bool[Strips];
        for (int s = 0; s < Strips; s++)
        {
            double u = (t - s * stagger) / StartStrip;
            on[s] = u > 0;
            h[s] = HMin + (HMax - HMin) * EaseOut(u);
        }
        return Draw(page, h, on);
    }

    public override bool[,] Stop(double t, bool[,] page)
    {
        if (t >= StopMs) return new bool[128, 64];
        t = Math.Max(0, t);
        double stagger = (StopMs - StopStrip) / (Strips - 1);
        var h = new double[Strips];
        var on = new bool[Strips];
        for (int s = 0; s < Strips; s++)
        {
            int order = Strips - 1 - s; // bottom strip first
            double u = (t - order * stagger) / StopStrip;
            on[s] = u < 1;
            h[s] = HMax - (HMax - HMin) * EaseIn(u);
        }
        return Draw(page, h, on);
    }

    // h: half opening in px around the strip centre; rows nearer than h show the page,
    // the first closed row on each side is the lit edge. on = false: the strip is black.
    static bool[,] Draw(bool[,] page, double[] h, bool[] on)
    {
        var o = new bool[128, 64];
        double c = (StripH - 1) / 2.0;
        for (int s = 0; s < Strips; s++)
        {
            if (!on[s]) continue;
            double hs = h[s];
            if (hs >= HMax) { for (int r = 0; r < StripH; r++) CopyRow(page, o, s * StripH + r); continue; }
            // distance of the edge ring: the smallest row distance (0.5, 1.5, ...) not below hs
            double edge = Math.Max(0.5, Math.Ceiling(hs - 0.5) + 0.5);
            for (int r = 0; r < StripH; r++)
            {
                int y = s * StripH + r;
                double d = Math.Abs(r - c);
                if (d < hs) CopyRow(page, o, y);
                else if (Math.Abs(d - edge) < 0.01 && edge < c)
                    for (int x = 0; x < 128; x++) o[x, y] = true; // the lit edge; the strip's outer rows open plainly, so edges of two strips never stack
            }
        }
        return o;
    }

    static void CopyRow(bool[,] page, bool[,] o, int y)
    {
        for (int x = 0; x < 128; x++) o[x, y] = page[x, y];
    }

    static double Clamp01(double u) { return Math.Max(0, Math.Min(1, u)); }
    // gentle in, long glide out
    static double EaseOut(double u)
    {
        u = Clamp01(u);
        double a = u * u * (3 - 2 * u);
        double b = 1 - Math.Pow(1 - u, 3);
        return 0.5 * a + 0.5 * b;
    }
    // stop: moves at once, settles softly into the centre line
    static double EaseIn(double u)
    {
        u = Clamp01(u);
        return 0.6 * (u * u * (3 - 2 * u)) + 0.4 * u;
    }
}

// anim-glitch.cs: digital glitch. Start: torn rows of the page jump sideways with short bursts of static, and settle
// until the page sits still (last third calm). Stop: the same rows tear apart sideways in a few hard jolts, then a thin
// line of static, then black. Every state is held for one 100 ms step so it reads the same at 10 and at 30 pictures a second.

class Anim_glitch : HsAnim
{
    public override string Key { get { return "glitch"; } }
    public override string Name { get { return "Glitch"; } }
    public override int StartMs { get { return 1100; } }
    public override int StopMs { get { return 500; } }

    const int W = 128, H = 64, Step = 100;
    const double CalmU = 0.64;

    // fixed row bands (top y, height) and the order they show up in; same layout for start and stop
    static readonly int[] BandY, BandH, BandDir;
    static readonly double[] BandOrder;

    static Anim_glitch()
    {
        var r = new Random(4127);
        var ys = new System.Collections.Generic.List<int>();
        var hs = new System.Collections.Generic.List<int>();
        int y = 0;
        while (y < H)
        {
            int h = 3 + r.Next(8);
            if (y + h > H) h = H - y;
            ys.Add(y); hs.Add(h); y += h;
        }
        BandY = ys.ToArray(); BandH = hs.ToArray();
        BandDir = new int[BandY.Length]; BandOrder = new double[BandY.Length];
        for (int i = 0; i < BandY.Length; i++)
        {
            BandDir[i] = (i % 2 == 0) ? 1 : -1;
            if (r.NextDouble() < 0.25) BandDir[i] = -BandDir[i];
            BandOrder[i] = r.NextDouble();
        }
    }

    public override bool[,] Start(double t, bool[,] page)
    {
        if (t >= StartMs) return (bool[,])page.Clone();
        if (t < 0) t = 0;
        int s = (int)(t / Step);
        var o = new bool[W, H];
        if (s == 0) { Line(o, 7); return o; }
        double u = (s * Step + Step * 0.5) / StartMs;
        if (u >= CalmU) return (bool[,])page.Clone();
        double I = Math.Pow(1 - u / CalmU, 1.5);                 // glitch strength, glides down to 0
        double reveal = 0.12 + 0.88 * Smooth((u - 0.08) / 0.42);               // share of bands that are showing
        var r = new Random(9001 + s * 131);
        for (int b = 0; b < BandY.Length; b++)
        {
            double roll = r.NextDouble(), mag = r.NextDouble();
            if (BandOrder[b] > reveal) continue;                 // not in yet: black
            int dx = 0;
            if (roll < 0.2 + 0.6 * I) dx = (int)Math.Round((r.NextDouble() < 0.5 ? -1 : 1) * (6 + 38 * mag) * I);
            CopyRows(o, page, BandY[b], BandH[b], dx);
        }
        if (I > 0.3) Blocks(o, page, r, I > 0.6 ? 2 : 1, I);
        if (r.NextDouble() < 0.2 + 0.8 * I) Static(o, r, s, 0.3 + 0.25 * I);
        return o;
    }

    public override bool[,] Stop(double t, bool[,] page)
    {
        var o = new bool[W, H];
        if (t >= StopMs) return o;
        if (t < 0) t = 0;
        int s = (int)(t / Step);
        if (s >= 4) { Line(o, 7); return o; }
        int[] mag = { 4, 14, 32, 64 };
        double[] keep = { 1.0, 1.0, 0.65, 0.3 };
        var r = new Random(7331 + s * 97);
        for (int b = 0; b < BandY.Length; b++)
        {
            double roll = r.NextDouble(), jit = r.NextDouble();
            if (BandOrder[b] > keep[s]) continue;
            int dx = 0;
            if (s > 0 || roll < 0.25) dx = (int)Math.Round(BandDir[b] * mag[s] * (0.55 + 0.45 * jit));
            CopyRows(o, page, BandY[b], BandH[b], dx);
        }
        if (s >= 1) Blocks(o, page, r, s, 0.4 + 0.2 * s);
        if (s >= 1) Static(o, r, 50 + s, 0.4 + 0.06 * s);
        return o;
    }

    static double Smooth(double u) { u = Math.Max(0, Math.Min(1, u)); return u * u * (3 - 2 * u); }

    static void CopyRows(bool[,] o, bool[,] page, int y0, int h, int dx)
    {
        for (int y = y0; y < y0 + h && y < H; y++)
            for (int x = 0; x < W; x++)
            {
                int sx = x - dx;
                o[x, y] = sx >= 0 && sx < W && page[sx, y];
            }
    }

    // a few rectangles of the page shifted on their own
    static void Blocks(bool[,] o, bool[,] page, Random r, int n, double I)
    {
        for (int k = 0; k < n; k++)
        {
            int bw = 14 + r.Next(30), bh = 4 + r.Next(8);
            int bx = r.Next(W - bw), by = r.Next(H - bh);
            int dx = (int)Math.Round((r.NextDouble() < 0.5 ? -1 : 1) * (6 + 18 * r.NextDouble()) * I);
            for (int y = by; y < by + bh; y++)
                for (int x = bx; x < bx + bw; x++)
                {
                    int sx = x - dx;
                    o[x, y] = sx >= 0 && sx < W && page[sx, y];
                }
        }
    }

    // a short burst of static: a band of 3 to 5 rows of noise across part of the screen
    static void Static(bool[,] o, Random r, int seed, double density)
    {
        int bh = 3 + r.Next(3), by = r.Next(H - bh);
        int bw = 48 + r.Next(72), bx = r.Next(W - bw + 1);
        for (int y = by; y < by + bh; y++)
            for (int x = bx; x < bx + bw; x++)
                o[x, y] = Hash(x / 2, y, seed) < density;     // 2 px wide grains stay crisp on the panel
    }

    // the thin line of static the start opens with and the stop ends on
    static void Line(bool[,] o, int seed)
    {
        for (int x = 20; x < 108; x++)
        {
            double edge = Math.Min(x - 20, 107 - x) / 20.0;      // thinner towards the ends
            o[x, 31] = Hash(x, 31, seed) < 0.35 + 0.4 * Math.Min(1, edge);
            o[x, 32] = Hash(x, 32, seed) < 0.15 * Math.Min(1, edge);
        }
    }

    static double Hash(int x, int y, int seed)
    {
        unchecked
        {
            uint h = (uint)(x * 374761393 + y * 668265263 + seed * 1274126177);
            h = (h ^ (h >> 13)) * 1274126177u;
            h ^= h >> 16;
            return (h & 0xffff) / 65536.0;
        }
    }
}

// anim-logo.cs: the headset as a logo.
// Start: a large line art headset draws itself stroke by stroke (headband from the top outward, then the ear cups,
// then the inner pad), holds, then a window opens in its middle: the page grows out of it as an oval while the
// headset zooms past the viewer and leaves. Stop: the same oval closes the page into the middle while the headset
// comes back from outside and settles small, then it shrinks to a dot that goes out.

class Anim_logo : HsAnim
{
    public override string Key { get { return "logo"; } }
    public override string Name { get { return "Headset"; } }
    public override int StartMs { get { return 1450; } }
    public override int StopMs { get { return 660; } }

    // start timeline
    const double DrawMs = 680, HoldEnd = 820;
    // stop timeline
    const double CloseMs = 380, RestEnd = 420, GoneMs = 540;
    const double BigS = 6, SmallS = 0.5, FullB = 47, Tie = 9.5;

    // one polyline in logo units (centre of the logo at 0,0, about 40 units tall), drawn mirrored too
    class Stroke
    {
        public double[] X, Y, Cum; public double Len, W0, W1;
        public Stroke(List<double> pts, double w0, double w1)
        {
            int n = pts.Count / 2; X = new double[n]; Y = new double[n]; Cum = new double[n];
            for (int i = 0; i < n; i++) { X[i] = pts[2 * i]; Y[i] = pts[2 * i + 1]; }
            for (int i = 1; i < n; i++) Cum[i] = Cum[i - 1] + Math.Sqrt((X[i] - X[i - 1]) * (X[i] - X[i - 1]) + (Y[i] - Y[i - 1]) * (Y[i] - Y[i - 1]));
            Len = Cum[n - 1]; W0 = w0; W1 = w1;
        }
    }

    static readonly List<Stroke> Strokes = Build();

    static void Arc(List<double> p, double cx, double cy, double r, double a0, double a1, int n)
    {
        for (int i = 0; i <= n; i++)
        {
            double a = (a0 + (a1 - a0) * i / n) * Math.PI / 180;
            p.Add(cx + r * Math.Cos(a)); p.Add(cy - r * Math.Sin(a));
        }
    }

    static List<Stroke> Build()
    {
        var s = new List<Stroke>();
        // headband: top centre out to the right cup (the mirror draws the left half at the same time)
        var band = new List<double>(); Arc(band, 0, 2, 22, 90, 0, 40); s.Add(new Stroke(band, 0.00, 0.42));
        // right ear cup (x 17..27, y 2..20, corner 4): from the top middle down both sides to the bottom middle
        double l = 17, r = 27, top = 2, bot = 20, c = 4, mid = 22;
        var outer = new List<double>();
        outer.Add(mid); outer.Add(top);
        Arc(outer, r - c, top + c, c, 90, 0, 8);
        Arc(outer, r - c, bot - c, c, 0, -90, 8);
        outer.Add(mid); outer.Add(bot);
        s.Add(new Stroke(outer, 0.36, 0.80));
        var inner = new List<double>();
        inner.Add(mid); inner.Add(top);
        Arc(inner, l + c, top + c, c, 90, 180, 8);
        Arc(inner, l + c, bot - c, c, 180, 270, 8);
        inner.Add(mid); inner.Add(bot);
        s.Add(new Stroke(inner, 0.36, 0.80));
        // inner pad of the headband, from the top out
        var pad = new List<double>(); Arc(pad, 0, 2, 17.5, 90, 38, 24); s.Add(new Stroke(pad, 0.70, 1.00));
        // the cushion on the inner face of the cup
        var cush = new List<double>(); cush.Add(20.5); cush.Add(7); cush.Add(20.5); cush.Add(15); s.Add(new Stroke(cush, 0.78, 1.00));
        return s;
    }

    static double Clamp01(double u) { return Math.Max(0, Math.Min(1, u)); }
    static double InOut(double u) { u = Clamp01(u); return u < 0.5 ? 4 * u * u * u : 1 - Math.Pow(-2 * u + 2, 3) / 2; }
    static double Sine(double u) { u = Clamp01(u); return 0.5 - 0.5 * Math.Cos(Math.PI * u); }

    // oval radius of a pixel (2:1, like the screen): the page shows where this is under b
    static double OvalR(int x, int y) { double dx = (x + 0.5 - 64) / 2, dy = y + 0.5 - 32; return Math.Sqrt(dx * dx + dy * dy); }

    // draws the logo at scale s (1 = 40 px tall) with progress p, only where keep[x,y] is false
    static void Logo(bool[,] o, double s, double p, double rad, bool[,] block)
    {
        double step = Math.Min(0.35, 0.35 / s);
        foreach (var st in Strokes)
        {
            double q = Clamp01((p - st.W0) / (st.W1 - st.W0));
            if (q <= 0) continue;
            double upto = st.Len * q;
            for (int i = 1; i < st.X.Length; i++)
            {
                double a = st.Cum[i - 1], b = st.Cum[i];
                if (a > upto) break;
                double e = Math.Min(b, upto), seg = b - a;
                for (double d = a; d <= e + 1e-9; d += step)
                {
                    double k = seg <= 0 ? 0 : (d - a) / seg;
                    double ux = st.X[i - 1] + (st.X[i] - st.X[i - 1]) * k, uy = st.Y[i - 1] + (st.Y[i] - st.Y[i - 1]) * k;
                    Stamp(o, 64 + ux * s, 32 + uy * s, rad, block);
                    Stamp(o, 64 - ux * s, 32 + uy * s, rad, block);
                }
            }
        }
    }

    static void Stamp(bool[,] o, double x, double y, double r, bool[,] block)
    {
        int x0 = (int)Math.Floor(x - r), x1 = (int)Math.Ceiling(x + r), y0 = (int)Math.Floor(y - r), y1 = (int)Math.Ceiling(y + r);
        double r2 = r * r;
        for (int i = Math.Max(0, x0); i <= Math.Min(127, x1); i++)
            for (int j = Math.Max(0, y0); j <= Math.Min(63, y1); j++)
            {
                double dx = i + 0.5 - x, dy = j + 0.5 - y;
                if (dx * dx + dy * dy < r2 && (block == null || !block[i, j])) o[i, j] = true;
            }
    }

    static double OvalFor(double s) { return Math.Max(0, Math.Min(FullB, Tie * (s - 1))); }

    static double Rad(double s) { return Math.Max(0.6, Math.Min(0.98, 0.98 * Math.Sqrt(s))); }

    // the page inside an oval of radius b with a 1 px rim, the logo outside it
    static bool[,] Opening(bool[,] page, double b, double s)
    {
        var o = new bool[128, 64];
        var block = new bool[128, 64];
        double rim = b + 1.1;
        for (int x = 0; x < 128; x++)
            for (int y = 0; y < 64; y++)
            {
                double e = OvalR(x, y);
                if (e < b) { o[x, y] = page[x, y]; block[x, y] = true; }
                else if (b > 0.6 && e < rim) { o[x, y] = true; block[x, y] = true; }
                else if (b > 0.6 && e < rim + 1.2) block[x, y] = true;   // a dark gap between the rim and the logo
            }
        Logo(o, s, 1, Rad(s), block);
        return o;
    }

    public override bool[,] Start(double t, bool[,] page)
    {
        if (t >= StartMs) return (bool[,])page.Clone();
        t = Math.Max(0, t);
        if (t < HoldEnd)
        {
            var o = new bool[128, 64];
            Logo(o, 1, Sine(t / DrawMs), 0.98, null);
            return o;
        }
        double u = Clamp01((t - HoldEnd) / (StartMs - HoldEnd));
        // the headset zooms past on a log scale; the oval stays inside it (between the cups, under the band)
        double s = Math.Pow(BigS, Sine(u));
        return Opening(page, OvalFor(s), s);
    }

    public override bool[,] Stop(double t, bool[,] page)
    {
        var o = new bool[128, 64];
        if (t >= StopMs) return o;
        t = Math.Max(0, t);
        if (t < CloseMs)
        {
            double u = t / CloseMs;
            double s = SmallS * Math.Pow(BigS / SmallS, 1 - Sine(u));
            return Opening(page, OvalFor(s), s);
        }
        if (t < RestEnd) { Logo(o, SmallS, 1, Rad(SmallS), null); return o; }
        if (t < GoneMs)
        {
            double v = (t - RestEnd) / (GoneMs - RestEnd);
            double s = SmallS * (1 - v * v);
            if (s * 40 > 3) { Logo(o, s, 1, Rad(s), null); return o; }
        }
        // the dot, then nothing
        for (int x = 63; x <= 64; x++) for (int y = 31; y <= 32; y++) o[x, y] = true;
        return o;
    }
}

// The headset base station's page (11-12). His own, built in the Headset screen popup (web\extras.js, opened from its
// card in Controls): one or more pages, each a grid of pieces (the clock, or a reading as a number, bar, ring, knob or
// graph), drawn by x-hsdraw.cs (Hs.Draw) with our own pixel fonts, every character its own bitmap with an empty column
// after it (his "42 46 48" bug, digits run together by GDI+, can't come back). And the start up / shut down animations
// he picked (x-hsdraw.cs too, played by x-batt.cs). hs-layout.json in the data folder keeps it all; with none, his pick 6
// and no animations. x-batt.cs asks HsPage.Draw(info) for the picture: once a second, every 250 ms for 4 s after the
// volume knob turns. Burn-in (an OLED): info.Dx / Dy move everything by a pixel a minute, the page stays mostly black.
// Nothing here talks to a device.

// what a picture may show (-1 or NaN: not known)
class HsInfo
{
    public DateTime Now;
    public int Dx, Dy;                       // the burn-in shift of this minute, 0 to 2 each
    public double Cpu = double.NaN, Gpu = double.NaN;   // HWiNFO's "CPU (Tctl/Tdie)" and "GPU Temperature", degrees C
    public int Head = -1;                    // the headset's battery, percent: the share of its running time left (HeadEst)
    public bool HeadOff, HeadCharging;       // switched off; charging by its cable
    public int Spare = -1;                   // the spare battery in the base's slot, percent
    public bool SpareOut, SpareCharging;     // no battery in the slot; the base is charging it (in the slot, not full)
    public int Mouse = -1;                   // the mouse's battery, percent (its last reading while it sleeps)
    public bool MouseCharging, MouseAsleep;
    public int Volume = -1;                  // the base's volume (its knob), 0 to 100
}

// a page as he builds it (his 11-12 "the number of rows does NOT represent the actual rows in there"): rows from the top,
// each as tall as he sets it (1 to 3 units, 5 units in all), its pieces side by side in it from the left, each 1 to 3
// columns wide. Drawn as the renderer's grid: a unit a grid row, every piece at its own place (Grid)
class HsRow { public int H = 1; public List<HsPiece> Pieces = new List<HsPiece>(); }
class HsRowPage { public int Cols = 2; public bool Lines = true; public int Gap = -1; public string From, When = "always"; public List<HsRow> Rows = new List<HsRow>(); }   // (From: the ready-made "p:<key>" or saved "s:<id>" page it started as; When: it shows always, only while a game runs ("game") or only while none does ("idle"), 11-13)
class HsSaved { public string Id, Name; public HsGPage Page; }                 // a page of his own kept under a name, as a saved look
class HsPreset { public string Key, Name, Group; public HsRowPage Page; public HsGPage G; public int Dig = 1; public string BarLook = "blocks"; public Dictionary<string, string[]> Icons; }   // a ready-made page (G: on the grid)
// v3 (11-13, the Customize revamp, his "split in 2, 3, 4, 5 and 6"): a page on a grid of 1 to 6 rows and columns, each
// piece at a cell (AtX, AtY) spanning W x H; its own name, gap and lines
class HsGPage { public bool Free; public int Dig = -1; public string Bar = ""; public string Name = "Page", When = "always", From; public int Rows = 2, Cols = 2, Gap = -1; public string Lines = "none"; public List<HsPiece> Pieces = new List<HsPiece>(); }
// a theme (his "keep my current setup and make them actual themes"): its pages, page change, start up / shut down, look
class HsTheme { public Dictionary<string, string[]> Icons; public string Id, Name; public List<HsGPage> Pages = new List<HsGPage>(); public int Every; public string Start = "", Stop = "", Bar = "blocks"; public int Digits = 1; }

// (11-18, the tester's F75) a data file that can't be read is copied aside as <file>.bad-<time> before the app starts
// over with its defaults, so the next save never loses his own data; never over an older copy
static class DataKeep
{
    public static void Bad(string path, Action<string> log)
    {
        try
        {
            if (path == null || !File.Exists(path)) return;
            string b = path + ".bad-" + DateTime.Now.ToString("yyyyMMdd-HHmmss", System.Globalization.CultureInfo.InvariantCulture);
            if (File.Exists(b)) return;
            File.Copy(path, b, false);
            if (log != null) log("kept the unreadable " + Path.GetFileName(path) + " as " + Path.GetFileName(b));
        }
        catch { }
    }
}

static class HsPage
{
    public static string File_;                       // hs-layout.json in the data folder
    public static Action<string> Log = delegate { };
    static readonly object gate = new object();       // the pages and Hs's readings: the headset's loop, the second, the popup
    static List<HsGPage> pages = new List<HsGPage>();   // the current theme's pages (filled by Load: his file, or the default page)
    static string themeName = "My headset", themeFrom;   // the current theme: its name, where it came from ("t:<id>" his own, "r:<key>" ready-made)
    static Dictionary<string, string[]> icons;           // the current theme's own icons (null: the built-in ones)
    static int digits = 1; static string bar = "blocks"; static readonly string[] Bars = { "blocks", "solid" }, LineKinds = { "none", "dotted", "solid" };
    static List<HsTheme> themes = new List<HsTheme>();  // his saved themes (Yours), 12 at most
    static int fileV;                                   // the version his file had (v2 kept aside before the first v3 save; newer: never saved over)
    static int every;                                 // seconds each page shows before the next; 0: the first page only
    static string startKey = "", stopKey = "";        // the animations he picked ("": none, his own choice, 11-12)
    static bool wheelFast;   // the Headset tab's "Faster volume wheel" (his 11-14 pick): the headset wheel's number sooner, the base's own volume screen flashing more often (experimental); off by default
    public static bool WheelFast { get { return wheelFast; } }
    static int focus = -1; static DateTime focusTill; // the page open in the popup shows on the base meanwhile
    static List<HsSaved> saved = new List<HsSaved>(); // his own pages kept under a name (Settings' Saved tiles), 12 at most
    public static Func<bool> Gaming = () => false;    // a game runs now (the app's own game watch): which pages show (their "when")
    static readonly string[] Whens = { "always", "game", "idle" };

    public static readonly HsAnim[] Anims = { new Anim_tv(), new Anim_scan(), new Anim_fade(), new Anim_sand(), new Anim_iris(), new Anim_blinds(), new Anim_glitch(), new Anim_logo() };
    static readonly string[] Styles = { "number", "bar", "ring", "knob", "graph" }, Labels = { "icon", "name", "off" }, Ats = { "beside", "above", "right", "below" }, Graphs = { "line", "smooth", "steps", "area", "bars", "dots" }, Sizes = { "auto", "s", "m", "l" }, Aligns = { "auto", "left", "middle", "right" };
    static readonly int[] Overs = { 60, 120, 600, 1800 }, Everys = { 0, 5, 10, 20, 30, 60 };
    static readonly string[] UAts = { "bottom", "middle", "top", "under" };   // (11-16 the unit: under the number's bottom as before, its middle, its top, under it)
    static readonly string[] DateAts = { "under", "beside" }, DateFmts = { "day", "short", "num", "wday" };   // (11-17 the clock's date)
    static readonly string[] NameSizes = { "auto", "small", "tiny" }, OffAses = { "word", "dash", "blank" }, ChgAses = { "blink", "steady", "none" }, LowAses = { "icon", "none", "num", "both" };
    // (11-17 his states) a state's own keys: its look only (where it is, what it reads, its levels stay the piece's)
    static readonly string[] StIcos = { "auto", "normal", "dim", "own" }, KAts = { "auto", "beside" }, StKeys = { "label", "at", "name", "size", "align", "dec", "unit", "num", "nsize", "dig", "inv", "offas", "offtxt", "chgas", "lowas", "vh", "vk", "wk", "bk", "uk", "ik", "vx", "vy", "ux", "uy", "ix", "iy", "uat", "ico", "kat", "kx", "ky" };
    const int MaxGrid = 6, MaxThemes = 12;   // (v3: rows and columns 1 to 6)
    const int MaxPages = 6, MaxUnits = 5, MaxSaved = 100, Keep = 1800;   // (100 saved pages: every theme's pages moved in, 12 x 6 + 12 at most, 11-15)   // (5 units: the screen's 62 rows of pixels; a graph: up to 30 min, a value a second)

    static HsPiece P(string src, string style = "number", int w = 1, string label = "icon") { return new HsPiece { Src = src, Style = style == "ring" || style == "knob" ? "number" : style, At = style == "ring" || style == "knob" ? "above" : "beside", Unit = style != "ring" && style != "knob", W = w, Label = label }; }   // (11-15: a battery's low level is Auto, 12 / the mouse 15, its Battery section)   // (11-14 a battery's low warning as a level he sees: red at 12 / 15, counting down)
    // the page it starts with: the ready-made Overview (the CPU's temperature as a graph with the GPU's dotted, under it
    // the headset and its spare, then the volume and the clock). No mouse, in HW Dashboard neither (his 11-13: "NOBODY
    // ELSE can see the mouse"): he adds it himself
    const string DefaultKey = "overview";
    static HsGPage Pick6() { foreach (var x in Presets()) if (x.Key == DefaultKey) return x.G; return Presets()[0].G; }
    // the renderer's grid for a page (v3): its rows and columns, each piece at its cell; the look is the theme's
    static HsLayout Grid(HsGPage pg) { return Grid(pg, digits, bar); }
    static HsLayout Grid(HsGPage pg, int dig, string barLook)
    {
        var L = new HsLayout { Rows = pg.Rows, Cols = pg.Cols, Gap = pg.Gap, Lines = pg.Lines != "none" && !pg.Free, SolidLines = pg.Lines == "solid", Digits = pg.Dig >= 0 ? pg.Dig : dig, SolidBar = (pg.Bar != "" ? pg.Bar : barLook) == "solid", Free = pg.Free, Icons = icons };
        L.Pieces.AddRange(pg.Pieces);
        return L;
    }
    // a v2 page (rows of height units) onto the grid: one grid row a unit, each row's pieces left to right at its first
    // unit, as tall as their row; lines dotted as they were, the gap as it was (-1). Drawn exactly as before (checked)
    static HsGPage FromRows(HsRowPage r, string name)
    {
        var g = new HsGPage { Name = name ?? "Page", When = r.When ?? "always", From = r.From, Cols = r.Cols, Gap = r.Gap, Lines = r.Lines ? "dotted" : "none" };
        int y = 0;
        foreach (var row in r.Rows)
        {
            int x = 0;
            foreach (var p0 in row.Pieces) { var p = p0.Copy(); p.AtX = x; p.AtY = y; p.H = row.H; p.W = Math.Max(1, Math.Min(p.W, r.Cols - x)); x += p.W; g.Pieces.Add(p); }
            y += row.H;
        }
        g.Rows = Math.Max(1, Math.Min(MaxUnits, y));
        return g;
    }
    static HsGPage CopyPage(HsGPage g)
    {
        var c = new HsGPage { Name = g.Name, When = g.When, From = g.From, Rows = g.Rows, Cols = g.Cols, Gap = g.Gap, Lines = g.Lines, Free = g.Free, Dig = g.Dig, Bar = g.Bar };
        foreach (var p in g.Pieces) c.Pieces.Add(p.Copy());
        return c;
    }
    static string NewId(Func<string, bool> taken) { string id; do id = "h" + Guid.NewGuid().ToString("N").Substring(0, 10); while (taken(id)); return id; }
    // the layout presets for a page (his "split in 2, 3, 4, 5 and 6"): its own pieces, in reading order, arranged anew
    // (their settings kept): two columns, a row each, a column each, the first big beside / over / a third of the rest
    static List<KeyValuePair<string, HsGPage>> Layouts(HsGPage pg)
    {
        var l = new List<KeyValuePair<string, HsGPage>>();
        var ps = new List<HsPiece>(pg.Pieces); ps.Sort((a1, b1) => a1.AtY != b1.AtY ? a1.AtY.CompareTo(b1.AtY) : a1.AtX.CompareTo(b1.AtX));
        int n = ps.Count; if (n == 0 || n > MaxGrid) return l;   // (more than 6: no presets, none would keep them all)
        Action<string, int, int, Func<int, int[]>> add = (name, rows, cols, at) =>
        {
            var g = new HsGPage { Name = pg.Name, When = pg.When, Rows = rows, Cols = cols, Gap = pg.Gap, Lines = pg.Lines, Dig = pg.Dig, Bar = pg.Bar };
            for (int k = 0; k < n; k++) { var q = ps[k].Copy(); var a2 = at(k); q.AtX = a2[0]; q.AtY = a2[1]; q.W = a2[2]; q.H = a2[3]; g.Pieces.Add(q); }
            l.Add(new KeyValuePair<string, HsGPage>(name, g));
        };
        if (n >= 2) add("2 columns", (n + 1) / 2, 2, k => new[] { k % 2, k / 2, n % 2 == 1 && k == n - 1 ? 2 : 1, 1 });
        add(n == 1 ? "Whole screen" : n + " rows", n, 1, k => new[] { 0, k, 1, 1 });
        if (n >= 2) add(n + " columns", 1, n, k => new[] { k, 0, 1, 1 });
        if (n >= 3) add("1 big beside", n - 1, 2, k => k == 0 ? new[] { 0, 0, 1, n - 1 } : new[] { 1, k - 1, 1, 1 });
        if (n >= 3) add("1 big on top", 2, n - 1, k => k == 0 ? new[] { 0, 0, n - 1, 1 } : new[] { k - 1, 1, 1, 1 });
        if (n >= 2) add("A third", n - 1, 3, k => k == 0 ? new[] { 0, 0, 1, n - 1 } : new[] { 1, k - 1, 2, 1 });
        return l;
    }

    // ---- saved ----
    public static void Load()
    {
        lock (gate) if (pages.Count == 0)   // (until his file says otherwise: the ready-made "Everyday", its first page the old default, Overview)
        {
            var t = Ready()[0];
            pages = t.Pages; themeName = t.Name; themeFrom = "r:" + t.Id; every = t.Every; digits = t.Digits; bar = t.Bar; icons = t.Icons;
        }
        try { if (File_ != null && File.Exists(File_)) { var d = new JavaScriptSerializer().DeserializeObject(File.ReadAllText(File_)) as Dictionary<string, object>; if (d == null) DataKeep.Bad(File_, s => Log(s)); lock (gate) { if (d != null) fileV = Int(d, "v", 1, 0, 999); lowMig = true; folded = false; try { Take(d); } finally { lowMig = false; } }
            if (fileV == 3) try { var v3s = Path.Combine(Path.GetDirectoryName(File_), "hs-layout.v3-start.json"); if (!File.Exists(v3s)) File.Copy(File_, v3s, false); } catch { }   // (the file as v3 began: written once, never over itself at each start (it took a renamed page over his copy at a restart, the tester's F48 11-16)
            if (folded)   // (his themes moved into saved pages: the file as it was kept first, never over an older copy; no copy, no save now, review 11-15)
            {
                folded = false; string keep = null;
                try { var dir = Path.GetDirectoryName(File_); keep = Path.Combine(dir, "hs-layout.v3-themes.json"); if (File.Exists(keep)) keep = Path.Combine(dir, "hs-layout.v3-themes-" + DateTime.Now.ToString("yyyyMMdd-HHmmss", CultureInfo.InvariantCulture) + ".json"); File.Copy(File_, keep); }
                catch (Exception ex) { Log("headset page: his themes not moved on disk yet, no copy: " + ex.Message); keep = null; }
                if (keep != null) { Save(); Log("headset page: his themes moved into saved pages (the file before: " + Path.GetFileName(keep) + ")"); }
            } } }   // (v3 as it was at this start: an older build writing over hs-layout.json loses nothing for good)
        catch (Exception ex)
        {
            Log("headset page: hs-layout.json unreadable, the default page instead (kept as hs-layout.json.bad): " + ex.Message);
            try { File.Copy(File_, File_ + ".bad", true); } catch { }   // (the next change writes a new file over it: his saved pages are in the copy)
            DataKeep.Bad(File_, s => Log(s));   // (and one that is never written over, 11-18)
        }
    }
    static bool newerSaid, lowMig, folded;   // (lowMig: the file being read at a start, 11-15: an old written battery default reads as Auto then, not on each change)
    static void Save()
    {
        if (File_ == null) return;
        if (fileV > 3) { if (!newerSaid) { newerSaid = true; Log("headset page: hs-layout.json is from a newer HW Deck (v" + fileV + "): not saved over"); } return; }
        try
        {
            if (fileV > 0 && fileV < 3 && File.Exists(File_))   // (his v1 / v2 file kept as it was, once, before the first v3 save)
            {
                var keep = Path.Combine(Path.GetDirectoryName(File_), "hs-layout.v2.json");
                if (!File.Exists(keep)) File.Copy(File_, keep);
                fileV = 3;
            }
            var tmp = File_ + ".tmp"; File.WriteAllText(tmp, new JavaScriptSerializer().Serialize(Setup()));
            if (File.Exists(File_)) File.Replace(tmp, File_, null); else File.Move(tmp, File_);
            if (SaveFailed) { SaveFailed = false; Log("headset page: saved after all"); }
        }
        catch (Exception ex) { if (!SaveFailed) Log("headset page: not saved (trying again every 5 s): " + ex.Message); SaveFailed = true; }
    }
    // (11-17: a save that failed is tried again by the host every 5 s and at the quit, so an edit made then is not lost)
    public static volatile bool SaveFailed;
    public static void Retry() { if (SaveFailed) Save(); }

    // the setup as JSON (the file, the popup), v3: {v, theme: {name, from, pages, every, start, stop, digits, bar},
    // themes: [{id, name, theme}], saved: [{id, name, page}], wheelfast}; a page {name, when, from, rows, cols, gap, lines,
    // pieces: [{x, y, w, h, src, style, ...}]}
    static Dictionary<string, object> Setup()
    {
        var th = ThemeDict(themeName, themeFrom, pages, every, startKey, stopKey, digits, bar, icons);
        var ts = new List<object>();
        foreach (var t in themes) ts.Add(new Dictionary<string, object> { { "id", t.Id }, { "name", t.Name }, { "theme", ThemeDict(null, null, t.Pages, t.Every, t.Start, t.Stop, t.Digits, t.Bar, t.Icons) } });
        var sv = new List<object>();
        foreach (var x in saved) sv.Add(new Dictionary<string, object> { { "id", x.Id }, { "name", x.Name }, { "page", PageDict(x.Page) } });
        return new Dictionary<string, object> { { "v", 3 }, { "theme", th }, { "themes", ts }, { "saved", sv }, { "wheelfast", wheelFast } };
    }
    static Dictionary<string, object> ThemeDict(string name, string from, List<HsGPage> ps, int ev, string st, string sp, int dig, string barLook, Dictionary<string, string[]> ic = null)
    {
        var pl = new List<object>(); foreach (var pg in ps) pl.Add(PageDict(pg));
        var d = new Dictionary<string, object> { { "pages", pl }, { "every", ev }, { "start", st }, { "stop", sp }, { "digits", dig }, { "bar", barLook } };
        if (ic != null && ic.Count > 0) { var id = new Dictionary<string, object>(); foreach (var kv in ic) id[kv.Key] = new List<object>(kv.Value); d["icons"] = id; }
        if (name != null) d["name"] = name;
        if (from != null) d["from"] = from;
        return d;
    }
    static Dictionary<string, object> PageDict(HsGPage pg)
    {
        var pcs = new List<object>();
        foreach (var p in pg.Pieces)
        {
            Func<double, object> N = d => double.IsNaN(d) ? null : (object)d;
            pcs.Add(new Dictionary<string, object> { { "x", p.AtX }, { "y", p.AtY }, { "w", p.W }, { "h", p.H }, { "src", p.Src }, { "style", p.Style }, { "label", p.Label }, { "at", p.At }, { "name", p.Name }, { "src2", p.Src2 }, { "graph", p.Graph }, { "over", p.Over }, { "seconds", p.Seconds },
                { "date", p.Date }, { "h12", p.H12 }, { "dateat", p.DateAt }, { "datefmt", p.DateFmt }, { "size", p.Size }, { "align", p.Align }, { "dec", p.Dec }, { "unit", p.Unit }, { "warn", N(p.Warn) }, { "crit", N(p.Crit) }, { "below", p.Below }, { "lo", N(p.Lo) }, { "hi", N(p.Hi) }, { "num", !p.NoNum }, { "nsize", p.NameSz }, { "dig", p.Dig }, { "inv", p.Inv }, { "offas", p.OffAs }, { "offtxt", p.OffTxt }, { "chgas", p.ChgAs }, { "lowas", p.LowAs },
                { "vh", p.VH }, { "wk", p.WK }, { "bk", p.BK }, { "uk", p.UK }, { "ik", p.IK }, { "vx", p.VX }, { "vy", p.VY }, { "ux", p.UX }, { "uy", p.UY }, { "ix", p.IX }, { "iy", p.IY }, { "uat", p.UAt }, { "fx", p.FX }, { "fy", p.FY }, { "fw", p.FW }, { "fh", p.FH }, { "kat", p.KAt }, { "kx", p.KX }, { "ky", p.KY } });
            if (p.StRaw != null) ((Dictionary<string, object>)pcs[pcs.Count - 1])["st"] = p.StRaw;   // (11-17 its states' own keys)
        }
        var page = new Dictionary<string, object> { { "name", pg.Name }, { "when", pg.When }, { "rows", pg.Rows }, { "cols", pg.Cols }, { "gap", pg.Gap }, { "lines", pg.Lines }, { "free", pg.Free }, { "dig", pg.Dig }, { "bar", pg.Bar }, { "pieces", pcs } };
        if (pg.From != null) page["from"] = pg.From;
        return page;
    }
    // ready-made pages to start from, in groups as Look's themes are by colour (his 11-13 "no defaults like themes",
    // then "the ready mades are terrible. you ALWAYS want to know the battery and the spare battery, and almost always
    // the volume, so those 3 are essentials. and why is the mouse battery on one of the ready mades, NOBODY ELSE can see
    // the mouse"): every one shows the headset, its spare and the volume; what else and how they are drawn differs;
    // none has the mouse
    static readonly string[] PresetKeys = { "cpu", "gpu", "head", "spare", "vol" };   // (what they read: kept for their graphs)
    static List<HsPreset> Presets()
    {
        var l = new List<HsPreset>();
        Func<int, HsPiece[], HsRow> R = (h, ps) => { var r = new HsRow { H = h }; r.Pieces.AddRange(ps); return r; };
        Action<string, string, string, int, bool, HsRow[]> add = (grp, key, name, cols, lines, rs) => { var pg = new HsRowPage { Cols = cols, Lines = lines, From = "p:" + key }; pg.Rows.AddRange(rs); l.Add(new HsPreset { Key = key, Name = name, Group = grp, G = FromRows(pg, name), Page = pg }); };
        Func<int, string, bool, HsPiece> Ck = (w, size, date) => { var c = P("clock", "number", w, "off"); c.Date = date; c.Size = size; return c; };   // (no label: his 11-17 "off by default in all the theme pages")
        Func<string, string, string, HsPiece> Gr = (src, src2, kind) => { var g = P(src, "graph", 1, "name"); g.Src2 = src2; g.Graph = kind; g.Over = 120; return g; };
        Func<HsPiece, int, HsPiece> W = (q, w) => { q.W = w; return q; };
        // the three alone
        add("Essentials", "bars", "Bars", 1, false, new[] { R(1, new[] { P("head", "bar") }), R(1, new[] { P("spare", "bar") }), R(1, new[] { P("vol", "bar") }) });
        add("Essentials", "rings", "Pair", 2, true, new[] { R(3, new[] { P("head", "ring"), P("spare", "ring") }), R(1, new[] { P("vol", "bar", 2) }) });
        add("Essentials", "dials", "Three across", 3, true, new[] { R(1, new[] { P("head", "ring"), P("spare", "ring"), P("vol", "knob") }) });
        add("Essentials", "large", "Large", 1, false, new[] { R(2, new[] { P("head") }), R(2, new[] { P("spare") }), R(1, new[] { P("vol", "bar") }) });
        add("Essentials", "list", "List", 1, true, new[] { R(1, new[] { P("head") }), R(1, new[] { P("spare") }), R(1, new[] { P("vol") }) });
        // with the time
        add("Clock", "clock", "Clock", 2, true, new[] { R(3, new[] { Ck(2, "auto", true) }), R(1, new[] { P("head"), P("spare") }), R(1, new[] { P("vol", "bar", 2) }) });
        add("Clock", "clockbars", "Clock and bars", 1, true, new[] { R(2, new[] { Ck(1, "auto", true) }), R(1, new[] { P("head", "bar") }), R(1, new[] { P("spare", "bar") }), R(1, new[] { P("vol", "bar") }) });
        add("Clock", "clockrings", "Clock and three", 3, true, new[] { R(2, new[] { Ck(3, "auto", false) }), R(3, new[] { P("head", "ring"), P("spare", "ring"), P("vol", "knob") }) });
        // with the CPU's and the GPU's temperatures
        add("Temperatures", "temps", "Temperatures", 2, true, new[] { R(2, new[] { P("cpu", "number", 1, "name"), P("gpu", "number", 1, "name") }), R(2, new[] { P("head"), P("spare") }), R(1, new[] { P("vol", "bar", 2) }) });
        add("Temperatures", "gauges", "Big temperatures", 2, true, new[] { R(3, new[] { P("cpu", "knob", 1, "name"), P("gpu", "knob", 1, "name") }), R(1, new[] { P("head"), P("spare") }), R(1, new[] { P("vol", "bar", 2) }) });
        add("Temperatures", "tempbars", "Temperature bars", 2, true, new[] { R(1, new[] { P("cpu", "bar", 2, "name") }), R(1, new[] { P("gpu", "bar", 2, "name") }), R(1, new[] { P("head"), P("spare") }), R(1, new[] { P("vol", "bar", 2) }) });
        // with a graph of them
        add("Graphs", "overview", "Overview", 2, true, new[] { R(2, new[] { W(Gr("cpu", "gpu", "line"), 2) }), R(1, new[] { P("head"), P("spare") }), R(1, new[] { P("vol"), Ck(1, "auto", false) }) });
        add("Graphs", "graph", "Graph", 2, true, new[] { R(3, new[] { W(Gr("cpu", "gpu", "area"), 2) }), R(1, new[] { P("head"), P("spare") }), R(1, new[] { P("vol", "bar", 2) }) });
        add("Graphs", "graphrings", "Graph and three", 3, true, new[] { R(2, new[] { W(Gr("gpu", null, "smooth"), 3) }), R(3, new[] { P("head", "ring"), P("spare", "ring"), P("vol", "knob") }) });
        // (11-14 his "draft some more themes and pages for headset too": ten more, each with the headset, the spare and the volume)
        Func<HsPiece, HsPiece> Inv = q => { q.Inv = true; return q; };
        Func<HsPiece, string, HsPiece> Nm = (q, n) => { q.Name = n; return q; };   // (a short name that fits a small ring)
        add("Clock", "bigclock", "Big clock", 3, false, new[] { R(3, new[] { Ck(3, "l", true) }), R(2, new[] { P("head"), P("spare"), P("vol") }) });
        add("Clock", "clockside", "Clock beside", 3, true, new[] { R(3, new[] { Ck(2, "auto", true), P("head", "ring") }), R(2, new[] { P("spare"), P("vol", "bar", 2) }) });
        add("Clock", "spotlight", "Spotlight", 2, false, new[] { R(2, new[] { Inv(P("head", "number", 2)) }), R(2, new[] { P("spare"), P("vol") }), R(1, new[] { Ck(2, "auto", false) }) });
        add("Load", "power", "Power", 2, true, new[] { R(3, new[] { Nm(P("cpuuse", "knob", 1, "name"), "CPU"), Nm(P("gpupow", "knob", 1, "name"), "GPU") }), R(1, new[] { P("head"), P("spare") }), R(1, new[] { P("vol", "bar", 2) }) });
        add("Load", "loadbars", "Load bars", 2, true, new[] { R(1, new[] { P("cpuuse", "bar", 2, "name") }), R(1, new[] { P("gpupow", "bar", 2, "name") }), R(2, new[] { P("head"), P("spare") }), R(1, new[] { P("vol", "bar", 2) }) });
        add("Load", "loadrings", "Load and headset", 3, true, new[] { R(3, new[] { Nm(P("cpuuse", "ring", 1, "name"), "CPU"), Nm(P("gpupow", "ring", 1, "name"), "GPU"), P("head", "ring") }), R(2, new[] { P("spare"), P("vol", "bar", 2) }) });
        add("Graphs", "dots", "Dots", 2, true, new[] { R(3, new[] { W(Gr("cpu", "gpu", "dots"), 2) }), R(1, new[] { P("head"), P("spare") }), R(1, new[] { P("vol", "bar", 2) }) });
        add("Graphs", "steps", "Steps", 2, true, new[] { R(3, new[] { W(Gr("gpupow", null, "steps"), 2) }), R(1, new[] { P("head"), P("spare") }), R(1, new[] { P("vol"), Ck(1, "auto", false) }) });
        add("Graphs", "loadgraph", "Load graph", 2, true, new[] { R(3, new[] { W(Gr("cpuuse", null, "bars"), 2) }), R(1, new[] { P("head"), P("spare") }), R(1, new[] { P("vol", "bar", 2) }) });
        add("Essentials", "inverted", "Inverted", 1, false, new[] { R(2, new[] { Inv(P("head")) }), R(2, new[] { P("spare") }), R(1, new[] { P("vol", "bar") }) });
        return l;
    }
    // the ready-made THEMES (11-14): 2 pages each from the ready-made pages, a page change, their own digits, bars and
    // lines. Every page has the headset, the spare and the volume; none has the mouse (his 11-13 rules)
    static List<HsTheme> Ready()
    {
        var pre = Presets(); var l = new List<HsTheme>(); var old = new Dictionary<string, string>(); var plain = new HashSet<string>();
        Action<string, string, int, int, string, string, string[]> add = (key, name, ev, dig, barLook, lines, keys) =>
        {
            var t = new HsTheme { Id = key, Name = name, Every = ev, Digits = dig, Bar = barLook };
            foreach (var k in keys) foreach (var x in pre) if (x.Key == k) { var pg = CopyPage(x.G); pg.Name = x.Name; pg.When = "always"; pg.Dig = dig; pg.Bar = barLook; pg.From = "p:" + key + t.Pages.Count; if (lines != null) pg.Lines = lines; if (!old.ContainsKey(k) || (lines == null && !plain.Contains(k))) { old[k] = key + t.Pages.Count; if (lines == null) plain.Add(k); } t.Pages.Add(pg); }   // (its key in the Pages gallery, 11-15)
            l.Add(t);
        };
        add("everyday", "Everyday", 10, 1, "blocks", null, new[] { "overview", "clockbars" });
        add("bignumbers", "Big numbers", 10, 2, "solid", "none", new[] { "large", "temps" });
        add("round", "Stacked", 10, 1, "solid", null, new[] { "rings", "clockrings" });
        add("gauges", "Columns", 10, 0, "blocks", null, new[] { "dials", "gauges" });
        add("compact", "Compact", 20, 1, "solid", "solid", new[] { "list", "tempbars" });
        add("timefirst", "Time first", 20, 1, "blocks", null, new[] { "clock", "clockbars" });
        add("graphs", "Graphs", 10, 1, "blocks", null, new[] { "graph", "graphrings" });
        // (11-14 his "draft some more themes and pages for headset too", his "Straight in": eight more)
        add("nightclock", "Night clock", 20, 0, "solid", "none", new[] { "bigclock", "bars" });
        add("spotlight", "Spotlight", 10, 1, "blocks", null, new[] { "spotlight", "clockbars" });
        add("gamer", "Gamer", 10, 2, "solid", "solid", new[] { "power", "loadbars" });
        add("digital", "Digital", 10, 3, "solid", null, new[] { "clock", "temps" });
        add("loadwatch", "Load watch", 10, 1, "blocks", null, new[] { "loadrings", "loadgraph" });
        add("dotted", "Dotted", 10, 1, "blocks", "dotted", new[] { "dots", "clockside" });
        add("steps", "Steps", 20, 2, "blocks", null, new[] { "steps", "rings" });
        add("bold", "Bold", 10, 2, "solid", "none", new[] { "inverted", "tempbars" });
        // (11-16 his "we could also use some more themes using the free layout just like in pc screen": themes whose pages
        // are Free, every piece at its own pixels of the 126 x 62 page as the PC screen's ready-made pages are, its cell kept
        // for Grid too (no two in one cell). Each page has the headset, the spare and the volume, none the mouse)
        Func<HsPiece, int[], HsPiece> Px = (q, a) => { q.FX = a[0]; q.FY = a[1]; q.FW = a[2]; q.FH = a[3]; q.AtX = a[4]; q.AtY = a[5]; q.W = a[6]; q.H = a[7]; return q; };   // (its pixels, then its cell)
        Func<string, int, int, HsPiece[], HsGPage> FP = (name, rows, cols, ps) => { var g = new HsGPage { Name = name, Rows = rows, Cols = cols, Free = true, Lines = "none" }; g.Pieces.AddRange(ps); return g; };
        Action<string, string, int, int, string, HsGPage[]> addF = (key, name, ev, dig, barLook, pgs) =>
        {
            var t = new HsTheme { Id = key, Name = name, Every = ev, Digits = dig, Bar = barLook };
            foreach (var pg in pgs) { pg.When = "always"; pg.Dig = dig; pg.Bar = barLook; pg.From = "p:" + key + t.Pages.Count; t.Pages.Add(pg); }
            l.Add(t);
        };
        addF("watch", "Watch", 10, 1, "blocks", new[] {
            FP("Watch face", 3, 2, new[] {
                Px(new HsPiece { Src = "clock", Label = "off", Date = false, Size = "l" }, new[] { 0, 12, 126, 38, 0, 1, 2, 1 }),
                Px(new HsPiece { Src = "head", Align = "left" }, new[] { 0, 0, 42, 11, 0, 0, 1, 1 }),
                Px(new HsPiece { Src = "spare", Align = "right" }, new[] { 78, 0, 48, 11, 1, 0, 1, 1 }),
                Px(new HsPiece { Src = "vol", Align = "left" }, new[] { 0, 51, 42, 11, 0, 2, 1, 1 }),
                Px(new HsPiece { Src = "cpu", Label = "name", Align = "right" }, new[] { 84, 51, 42, 11, 1, 2, 1, 1 }) }),
            FP("Headset watch", 3, 2, new[] {
                Px(new HsPiece { Src = "head", IK = 2, Size = "l" }, new[] { 0, 12, 126, 38, 0, 1, 2, 1 }),
                Px(new HsPiece { Src = "clock", Label = "off", Date = false, Align = "left" }, new[] { 0, 0, 42, 11, 0, 0, 1, 1 }),
                Px(new HsPiece { Src = "spare", Align = "right" }, new[] { 78, 0, 48, 11, 1, 0, 1, 1 }),
                Px(new HsPiece { Src = "vol", Align = "left" }, new[] { 0, 51, 42, 11, 0, 2, 1, 1 }),
                Px(new HsPiece { Src = "gpu", Label = "name", Align = "right" }, new[] { 84, 51, 42, 11, 1, 2, 1, 1 }) }) });
        addF("sidebar", "Sidebar", 10, 0, "solid", new[] {
            FP("Clock and column", 6, 3, new[] {
                Px(new HsPiece { Src = "clock", Label = "off", Size = "l" }, new[] { 0, 0, 88, 62, 0, 0, 2, 6 }),
                Px(new HsPiece { Src = "head", At = "above" }, new[] { 92, 0, 34, 17, 2, 0, 1, 2 }),
                Px(new HsPiece { Src = "spare", At = "above" }, new[] { 92, 22, 34, 17, 2, 2, 1, 2 }),
                Px(new HsPiece { Src = "vol", At = "above" }, new[] { 92, 45, 34, 17, 2, 4, 1, 2 }) }),
            FP("Temps and column", 6, 3, new[] {
                Px(new HsPiece { Src = "cpu", Label = "name" }, new[] { 0, 0, 88, 30, 0, 0, 2, 3 }),
                Px(new HsPiece { Src = "gpu", Label = "name" }, new[] { 0, 32, 88, 30, 0, 3, 2, 3 }),
                Px(new HsPiece { Src = "head", At = "above" }, new[] { 92, 0, 34, 17, 2, 0, 1, 2 }),
                Px(new HsPiece { Src = "spare", At = "above" }, new[] { 92, 22, 34, 17, 2, 2, 1, 2 }),
                Px(new HsPiece { Src = "vol", At = "above" }, new[] { 92, 45, 34, 17, 2, 4, 1, 2 }) }) });
        addF("hero", "Hero", 10, 1, "blocks", new[] {
            FP("Headset hero", 2, 3, new[] {
                Px(new HsPiece { Src = "head", At = "above", IK = 2, Size = "l" }, new[] { 0, 5, 90, 52, 0, 0, 2, 2 }),
                Px(new HsPiece { Src = "spare", At = "above" }, new[] { 94, 6, 32, 24, 2, 0, 1, 1 }),
                Px(new HsPiece { Src = "vol", At = "above" }, new[] { 94, 32, 32, 24, 2, 1, 1, 1 }) }),
            FP("Volume hero", 2, 3, new[] {
                Px(new HsPiece { Src = "vol", At = "above", IK = 2, Size = "l" }, new[] { 0, 5, 90, 52, 0, 0, 2, 2 }),
                Px(new HsPiece { Src = "head", At = "above" }, new[] { 94, 6, 32, 24, 2, 0, 1, 1 }),
                Px(new HsPiece { Src = "spare", At = "above" }, new[] { 94, 32, 32, 24, 2, 1, 1, 1 }) }) });
        addF("twin", "Twin", 10, 3, "solid", new[] {
            FP("Twin graphs", 2, 6, new[] {
                Px(new HsPiece { Src = "cpu", Style = "graph", Label = "name", Graph = "line" }, new[] { 0, 0, 59, 44, 0, 0, 3, 1 }),
                Px(new HsPiece { Src = "gpu", Style = "graph", Label = "name", Graph = "line" }, new[] { 67, 0, 59, 44, 3, 0, 3, 1 }),
                Px(new HsPiece { Src = "head", Dig = 1 }, new[] { 0, 48, 36, 14, 0, 1, 2, 1 }),
                Px(new HsPiece { Src = "spare", Dig = 1 }, new[] { 39, 48, 48, 14, 2, 1, 2, 1 }),
                Px(new HsPiece { Src = "vol", Dig = 1 }, new[] { 90, 48, 36, 14, 4, 1, 2, 1 }) }),
            FP("Twin temps", 2, 6, new[] {
                Px(new HsPiece { Src = "cpu", Label = "name", At = "above", Size = "l" }, new[] { 0, 0, 61, 42, 0, 0, 3, 1 }),
                Px(new HsPiece { Src = "gpu", Label = "name", At = "above", Size = "l" }, new[] { 65, 0, 61, 42, 3, 0, 3, 1 }),
                Px(new HsPiece { Src = "head", Dig = 1 }, new[] { 0, 47, 36, 15, 0, 1, 2, 1 }),
                Px(new HsPiece { Src = "spare", Dig = 1 }, new[] { 39, 47, 48, 15, 2, 1, 2, 1 }),
                Px(new HsPiece { Src = "vol", Dig = 1 }, new[] { 90, 47, 36, 15, 4, 1, 2, 1 }) }) });
        addF("ticker", "Ticker", 0, 2, "blocks", new[] {
            FP("Graph and bars", 5, 1, new[] {
                Px(new HsPiece { Src = "cpu", Style = "graph", Label = "name", Src2 = "gpu", Graph = "line" }, new[] { 0, 0, 126, 30, 0, 0, 1, 2 }),
                Px(new HsPiece { Src = "head", Style = "bar" }, new[] { 0, 33, 126, 9, 0, 2, 1, 1 }),
                Px(new HsPiece { Src = "spare", Style = "bar" }, new[] { 0, 43, 126, 9, 0, 3, 1, 1 }),
                Px(new HsPiece { Src = "vol", Style = "bar" }, new[] { 0, 53, 126, 9, 0, 4, 1, 1 }) }) });
        prePage = old;
        return l;
    }
    // the Pages gallery (11-15 his "the pages templates should ONLY be the sames as the ones in the themes and vice versa"):
    // every ready-made theme's pages, a group a theme, each as it is in that theme and drawn in its digits, bars and icons
    static List<HsPreset> Templates()
    {
        var l = new List<HsPreset>();
        foreach (var t in Ready()) for (int k = 0; k < t.Pages.Count; k++) l.Add(new HsPreset { Key = t.Id + k, Name = t.Pages[k].Name, Group = t.Name, G = t.Pages[k], Dig = t.Digits, BarLook = t.Bar, Icons = t.Icons });
        return l;
    }
    // a page from an older ready-made page ("p:overview"): from the first theme page made of it now ("p:everyday0")
    static Dictionary<string, string> prePage;
    static string FromFix(string f)
    {
        if (f == null || !f.StartsWith("p:")) return f;
        if (prePage == null) Ready();
        string to; return prePage.TryGetValue(f.Substring(2), out to) ? "p:" + to : f;
    }
    // his own themes into saved pages, once (11-15 his "saving themes makes no sense, you should only be able to save
    // pages ... fix my saves accordingly (and fix for other users)"): each theme page not saved already becomes one (a
    // one-page theme's under the theme's name, else "<page> (<theme>)"); the list is left empty; a page on the screen the
    // same as a saved one is from it. True when it moved something (the start then keeps a copy of the file and saves)
    static bool FoldThemes()
    {
        if (themes.Count == 0) { if (themeFrom != null && themeFrom.StartsWith("t:")) themeFrom = null; return false; }   // (nothing to move: the page's every change comes through here)
        bool moved = true;
        var js = new JavaScriptSerializer();
        Func<HsGPage, string> core = pg => { var d = PageDict(pg); d.Remove("name"); d.Remove("from"); d.Remove("when"); return js.Serialize(d); };
        var ids = new HashSet<string>(); foreach (var x in saved) ids.Add(x.Id);
        var have = new HashSet<string>(); foreach (var x in saved) have.Add(core(x.Page));
        foreach (var t in themes)
            for (int k = 0; k < t.Pages.Count; k++)
            {
                var pg = t.Pages[k]; if (pg.Pieces.Count == 0 || saved.Count >= MaxSaved) continue;
                string c = core(pg); if (!have.Add(c)) continue;
                string nm = t.Pages.Count == 1 ? t.Name : (pg.Name ?? "Page " + (k + 1)) + " (" + t.Name + ")"; if (nm.Length > 36) nm = nm.Substring(0, 36).TrimEnd();
                var names = new HashSet<string>(); foreach (var x in saved) names.Add(x.Name); string n1 = nm; int q = 2; while (names.Contains(n1)) n1 = nm + " " + q++;
                var cp = CopyPage(pg); cp.From = null; cp.Name = n1.Length > 24 ? n1.Substring(0, 24).TrimEnd() : n1;
                string id = NewId(z => ids.Contains(z)); ids.Add(id);
                saved.Add(new HsSaved { Id = id, Name = n1, Page = cp });
            }
        themes = new List<HsTheme>();
        if (themeFrom != null && themeFrom.StartsWith("t:")) themeFrom = null;
        if (moved)
            foreach (var pg in pages)
            {
                bool linked = false; if (pg.From != null && pg.From.StartsWith("s:")) foreach (var x in saved) if ("s:" + x.Id == pg.From) linked = true;
                if (linked || (pg.From != null && pg.From.StartsWith("p:"))) continue;
                string c = core(pg); foreach (var x in saved) if (core(x.Page) == c) { pg.From = "s:" + x.Id; break; }
            }
        return moved;
    }
    // what came in, checked: anything out of range takes its default; a row past the 5 units, or a piece past its row's
    // columns, is left out; no page: his pick 6. The first saves (11-12 23:00, a grid with pieces 1 to 5 cells tall) are
    // turned into rows: each piece's row is where its top landed, as tall as its tallest piece
    static void Take(Dictionary<string, object> d)
    {
        if (d == null) return;
        if (Int(d, "v", 1, 0, 999) >= 3) { TakeV3(d); return; }
        // v1 / v2 (his file before the revamp): rows of units, saved pages; moved onto the grid, drawn as they were
        var ps = new List<HsGPage>();
        foreach (var o in List(d, "pages"))
        {
            var pd = o as Dictionary<string, object>; if (pd == null || ps.Count >= MaxPages) continue;
            object ro; pd.TryGetValue("rows", out ro);
            var pg = ro is IEnumerable && !(ro is string) ? Rows(pd) : FromGrid(pd);
            if (pg != null) ps.Add(FromRows(pg, "Page " + (ps.Count + 1)));
        }
        pages = ps.Count > 0 ? ps : new List<HsGPage> { Pick6() };
        object so; d.TryGetValue("saved", out so);
        if (so is IEnumerable && !(so is string) && !(so is IDictionary))
        {
            var sv = new List<HsSaved>(); var ids = new HashSet<string>();
            foreach (var o in List(d, "saved"))
            {
                var sd = o as Dictionary<string, object>; if (sd == null || sv.Count >= MaxSaved) continue;
                string id = Str(sd, "id"), nm = Str(sd, "name"); object po; sd.TryGetValue("page", out po);
                var pd = po as Dictionary<string, object>;
                if (pd == null) continue;
                if (!IdOk(id) || !ids.Add(id)) { do id = "h" + Guid.NewGuid().ToString("N").Substring(0, 10); while (!ids.Add(id)); }
                var pg = Rows(pd); pg.From = null; if (pg.Rows.Count == 0) continue;
                if (nm == null) nm = "Page"; if (nm.Length > 40) nm = nm.Substring(0, 40).TrimEnd();
                sv.Add(new HsSaved { Id = id, Name = nm, Page = FromRows(pg, nm) });
            }
            saved = sv;
        }
        int ev = Int(d, "every", 0, 0, 3600); every = Array.IndexOf(Everys, ev) >= 0 ? ev : 0;
        startKey = AnimKey(Str(d, "start")); stopKey = AnimKey(Str(d, "stop"));
        if (d.ContainsKey("wheelfast")) wheelFast = true.Equals(d["wheelfast"]);
        digits = 1; bar = "blocks"; icons = null;
        // (his setup kept as a theme of his own, picked: "My headset")
        if (themes.Count == 0)
        {
            var t = new HsTheme { Id = NewId(x => false), Name = "My headset", Every = every, Start = startKey, Stop = stopKey, Digits = digits, Bar = bar };
            foreach (var pg in pages) t.Pages.Add(CopyPage(pg));
            themes.Add(t); themeName = t.Name; themeFrom = "t:" + t.Id;
        }
        if (FoldThemes()) folded = true;
        if (focus >= pages.Count) focus = -1;
    }
    static void TakeV3(Dictionary<string, object> d)
    {
        var td = Dict(d, "theme");
        if (td != null)
        {
            var t = ThemeOf(td);
            pages = t.Pages.Count > 0 ? t.Pages : new List<HsGPage> { Pick6() };
            every = t.Every; startKey = t.Start; stopKey = t.Stop; digits = t.Digits; bar = t.Bar; icons = t.Icons;
            var nm = Str(td, "name"); themeName = nm == null ? "Custom" : nm.Length > 40 ? nm.Substring(0, 40).TrimEnd() : nm;
            var fr = Str(td, "from"); themeFrom = fr != null && fr.Length > 2 && (fr.StartsWith("t:") || fr.StartsWith("r:")) && IdOk(fr.Substring(2)) ? fr : null;
        }
        object to; d.TryGetValue("themes", out to);
        if (to is IEnumerable && !(to is string) && !(to is IDictionary))   // (a setup without the list keeps them as they are)
        {
            var tl = new List<HsTheme>(); var ids = new HashSet<string>();
            foreach (var o in List(d, "themes"))
            {
                var x = o as Dictionary<string, object>; if (x == null || tl.Count >= MaxThemes) continue;
                var t = ThemeOf(Dict(x, "theme")); if (t.Pages.Count == 0) continue;
                string id = Str(x, "id"), nm = Str(x, "name");
                if (!IdOk(id) || !ids.Add(id)) { id = NewId(z => ids.Contains(z)); ids.Add(id); }
                t.Id = id; t.Name = nm == null ? "Theme" : nm.Length > 40 ? nm.Substring(0, 40).TrimEnd() : nm;
                tl.Add(t);
            }
            themes = tl;
        }
        object so; d.TryGetValue("saved", out so);
        if (so is IEnumerable && !(so is string) && !(so is IDictionary))
        {
            var sv = new List<HsSaved>(); var ids = new HashSet<string>();
            foreach (var o in List(d, "saved"))
            {
                var sd = o as Dictionary<string, object>; if (sd == null || sv.Count >= MaxSaved) continue;
                var pg = PageOf(Dict(sd, "page")); if (pg == null || pg.Pieces.Count == 0) continue;
                string id = Str(sd, "id"), nm = Str(sd, "name");
                if (!IdOk(id) || !ids.Add(id)) { id = NewId(z => ids.Contains(z)); ids.Add(id); }
                if (nm == null) nm = "Page"; if (nm.Length > 40) nm = nm.Substring(0, 40).TrimEnd();
                pg.From = null; sv.Add(new HsSaved { Id = id, Name = nm, Page = pg });
            }
            saved = sv;
        }
        if (d.ContainsKey("wheelfast")) wheelFast = true.Equals(d["wheelfast"]);
        if (FoldThemes()) folded = true;
        if (focus >= pages.Count) focus = -1;
    }
    static int IntC(Dictionary<string, object> d, string k, int def, int lo, int hi) { object o; if (!d.TryGetValue(k, out o) || o == null) return def; double v; try { v = Convert.ToDouble(o); } catch { return def; } if (double.IsNaN(v)) return def; return (int)Math.Max(lo, Math.Min(hi, Math.Round(v))); }
    static Dictionary<string, object> Dict(Dictionary<string, object> d, string k) { object o; return d != null && d.TryGetValue(k, out o) ? o as Dictionary<string, object> : null; }
    static HsTheme ThemeOf(Dictionary<string, object> td)
    {
        var t = new HsTheme(); if (td == null) return t;
        foreach (var o in List(td, "pages")) { if (t.Pages.Count >= MaxPages) break; var pg = PageOf(o as Dictionary<string, object>); if (pg != null) t.Pages.Add(pg); }
        int ev = Int(td, "every", 0, 0, 3600); t.Every = Array.IndexOf(Everys, ev) >= 0 ? ev : 0;
        t.Start = AnimKey(Str(td, "start")); t.Stop = AnimKey(Str(td, "stop"));
        t.Digits = Int(td, "digits", 1, 0, 3); t.Bar = Pick(td, "bar", Bars);
        t.Icons = IconsOf(Dict(td, "icons"));
        return t;
    }
    // a theme's icons: rows of X (lit) and . (dark), 1 to 13 rows of 1 to 13, at most 32 of them; a bad one is left out
    static Dictionary<string, string[]> IconsOf(Dictionary<string, object> d)
    {
        if (d == null) return null;
        var r = new Dictionary<string, string[]>();
        foreach (var kv in d)
        {
            if (r.Count >= 32 || string.IsNullOrEmpty(kv.Key) || kv.Key.Length > 64 || kv.Value is string) continue;
            var en = kv.Value as IEnumerable; if (en == null) continue;
            var rows = new List<string>(); int w = 0; bool bad = false;
            foreach (var o in en)
            {
                var s = o as string;
                if (s == null || s.Length == 0 || s.Length > 13 || rows.Count >= 13) { bad = true; break; }
                foreach (char ch in s) if (ch != 'X' && ch != '.') bad = true;
                rows.Add(s); w = Math.Max(w, s.Length);
            }
            if (bad || rows.Count == 0) continue;
            var a = new string[rows.Count]; for (int k = 0; k < a.Length; k++) a[k] = rows[k].PadRight(w, '.');
            r[kv.Key] = a;
        }
        return r.Count > 0 ? r : null;
    }
    // the built-in icons (the editor's "Reset to default" and its starting point)
    static readonly string[] SpareRows = { "XXXXXXXXXXXX.", "X..........X.", "X..........XX", "X..........XX", "X..........XX", "X..........X.", "XXXXXXXXXXXX." };
    static Dictionary<string, object> IconDefaults()
    {
        Func<string[], object> L = a => new List<object>(a);
        return new Dictionary<string, object> { { "head", L(Ico.Headset) }, { "spare", L(SpareRows) }, { "vol", L(Ico.Speaker) }, { "mute", L(Ico.Mute) }, { "mouse", L(Ico.Mouse) }, { "bolt", L(Ico.Bolt) }, { "clock", L(Ico.Clock) } };
    }
    // a v3 page: its grid, each piece at its cell inside it; one that would cover another's cell is left out
    static HsGPage PageOf(Dictionary<string, object> pd)
    {
        if (pd == null) return null;
        object ro; pd.TryGetValue("rows", out ro);
        if (ro is IEnumerable && !(ro is string)) { var r = Rows(pd); return r.Rows.Count > 0 ? FromRows(r, Str(pd, "name") ?? "Page") : null; }   // (a v2 page inside: moved over)
        var g = new HsGPage { Rows = Int(pd, "rows", 2, 1, MaxGrid), Cols = Int(pd, "cols", 2, 1, MaxGrid), Gap = Int(pd, "gap", -1, -1, 6), Lines = Pick(pd, "lines", LineKinds), When = Pick(pd, "when", Whens) };
        var nm = Str(pd, "name"); g.Name = nm == null ? "Page" : nm.Length > 24 ? nm.Substring(0, 24).TrimEnd() : nm;
        g.Free = Bool(pd, "free", false); g.Dig = Int(pd, "dig", -1, -1, 3); var br = Str(pd, "bar"); g.Bar = br != null && Array.IndexOf(Bars, br) >= 0 ? br : "";   // (11-16)
        string from = Str(pd, "from"); if (from != null && from.Length > 2 && (from.StartsWith("p:") || from.StartsWith("s:")) && IdOk(from.Substring(2))) g.From = FromFix(from);
        var own = new bool[g.Rows, g.Cols];
        foreach (var q in List(pd, "pieces"))
        {
            var qd = q as Dictionary<string, object>; var p = Piece(qd); if (p == null) continue;
            int x = IntC(qd, "x", 0, 0, g.Cols - 1), y = IntC(qd, "y", 0, 0, g.Rows - 1), w = IntC(qd, "w", 1, 1, g.Cols - x), h = IntC(qd, "h", 1, 1, g.Rows - y);   // (clamped: a hand-edited place stays near where it was)
            bool free = true; for (int a2 = 0; a2 < h; a2++) for (int b2 = 0; b2 < w; b2++) if (own[y + a2, x + b2] && !g.Free) free = false;
            if (!free) continue;
            for (int a2 = 0; a2 < h; a2++) for (int b2 = 0; b2 < w; b2++) own[y + a2, x + b2] = true;
            p.AtX = x; p.AtY = y; p.W = w; p.H = h; g.Pieces.Add(p);
        }
        return g;
    }
    static HsRowPage Rows(Dictionary<string, object> pd)
    {
        var pg = new HsRowPage { Cols = Int(pd, "cols", 2, 1, 3), Lines = Bool(pd, "lines", true) };   // (no "gap": the setting went, his 11-13 "bad fix")
        pg.When = Pick(pd, "when", Whens);
        string from = Str(pd, "from"); if (from != null && from.Length > 2 && (from.StartsWith("p:") || from.StartsWith("s:")) && IdOk(from.Substring(2))) pg.From = FromFix(from);
        int units = 0;
        foreach (var r in List(pd, "rows"))
        {
            var rd = r as Dictionary<string, object>; if (rd == null) continue;
            var row = new HsRow { H = Int(rd, "h", 1, 1, 3) };
            if (units + row.H > MaxUnits) break;
            units += row.H;
            int x = 0;
            foreach (var q in List(rd, "pieces"))
            {
                var p = Piece(q as Dictionary<string, object>); if (p == null) continue;
                p.W = Math.Min(p.W, pg.Cols); if (x + p.W > pg.Cols) continue;
                x += p.W; row.Pieces.Add(p);
            }
            pg.Rows.Add(row);
        }
        return pg;
    }
    static HsRowPage FromGrid(Dictionary<string, object> pd)
    {
        var L = new HsLayout { Rows = Int(pd, "rows", 4, 1, 5), Cols = Int(pd, "cols", 2, 1, 3), Lines = Bool(pd, "lines", true) };
        foreach (var q in List(pd, "pieces")) { var qd = q as Dictionary<string, object>; var p = Piece(qd); if (p == null) continue; p.H = qd != null ? Int(qd, "h", 1, 1, 5) : 1; L.Pieces.Add(p); }
        Hs.Place(L);
        var pg = new HsRowPage { Cols = L.Cols, Lines = L.Lines };
        var tops = new SortedDictionary<int, List<HsPiece>>();
        foreach (var p in L.Pieces) if (p.X >= 0) { List<HsPiece> l; if (!tops.TryGetValue(p.Y, out l)) tops[p.Y] = l = new List<HsPiece>(); l.Add(p); }
        var ys = new List<int>(tops.Keys); int units = 0;
        for (int k = 0; k < ys.Count; k++)
        {
            int next = k + 1 < ys.Count ? ys[k + 1] : L.Rows, h = 1;
            foreach (var p in tops[ys[k]]) h = Math.Max(h, Math.Min(p.H, L.Rows - p.Y));
            h = Math.Max(1, Math.Min(3, Math.Min(h, next - ys[k])));
            if (units + h > MaxUnits) break;
            units += h;
            var row = new HsRow { H = h };
            var l2 = tops[ys[k]]; l2.Sort((a, b) => a.X.CompareTo(b.X));
            foreach (var p in l2) { p.AtX = p.AtY = -1; row.Pieces.Add(p); }
            pg.Rows.Add(row);
        }
        return pg.Rows.Count > 0 ? pg : null;
    }
    // a ready-made page's key, a saved page's id: lower-case letters and digits, 40 at most
    static bool IdOk(string id) { if (id == null || id.Length == 0 || id.Length > 40) return false; foreach (char ch in id) if (!((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9'))) return false; return true; }
    static HsPiece Piece(Dictionary<string, object> qd)
    {
        if (qd == null) return null;
        string src = Str(qd, "src"); if (src == null) return null;
        var p = new HsPiece { Src = src, Style = Pick(qd, "style", Styles), Label = Pick(qd, "label", Labels), At = Pick(qd, "at", Ats), W = Int(qd, "w", 1, 1, MaxGrid), Src2 = Str(qd, "src2"), Graph = Pick(qd, "graph", Graphs), Seconds = Bool(qd, "seconds", false), Date = Bool(qd, "date", true),
            Size = Pick(qd, "size", Sizes), Align = Pick(qd, "align", Aligns), Dec = Int(qd, "dec", 0, 0, 2), Unit = Bool(qd, "unit", true), Warn = Num(qd, "warn"), Crit = Num(qd, "crit"), Lo = Num(qd, "lo"), Hi = Num(qd, "hi") };
        if (lowMig && double.IsNaN(p.Warn) && (p.Src == "head" || p.Src == "spare" ? p.Crit == 12 : p.Src == "mouse" && p.Crit == 15)) p.Crit = double.NaN;   // (11-15: the old written default of a battery's low level is its Auto)
        object bo; if (qd.TryGetValue("below", out bo) && bo is bool) p.Below = (bool)bo;
        object nb; if (qd.TryGetValue("num", out nb) && nb is bool) p.NoNum = !(bool)nb;   // (v3)
        p.NameSz = Pick(qd, "nsize", NameSizes); p.Dig = Int(qd, "dig", -1, -1, 3); p.Inv = Bool(qd, "inv", false);   // (11-14)
        p.H12 = Bool(qd, "h12", false); p.DateAt = Pick(qd, "dateat", DateAts); p.DateFmt = Pick(qd, "datefmt", DateFmts);   // (11-17 the clock's own)
        if (p.Src == "clock" && !qd.ContainsKey("label")) p.Label = "off";   // (a clock from before 11-17: no label, as it was drawn)
        p.OffAs = Pick(qd, "offas", OffAses); p.ChgAs = Pick(qd, "chgas", ChgAses); p.LowAs = Pick(qd, "lowas", LowAses); var ot = Str(qd, "offtxt"); if (ot != null) { ot = Caps(ot).Trim(); if (ot.Length > 6) ot = ot.Substring(0, 6).TrimEnd(); p.OffTxt = ot.Length > 0 ? ot : null; }   // (11-14 his battery states)
        var nm = Str(qd, "name"); if (nm != null) { nm = Caps(nm); if (nm.Length > 16) nm = nm.Substring(0, 16).TrimEnd(); p.Name = nm.Length > 0 ? nm : null; }   // (his own label words, in the screen's letters)
        int over = Int(qd, "over", 120, 1, Keep); p.Over = Array.IndexOf(Overs, over) >= 0 ? over : 120;
        if (p.Src2 == "clock" || p.Src2 == p.Src) p.Src2 = null;
        if (p.Style == "ring" || p.Style == "knob") p.Style = "number";   // (11-16 his "all dials look bad ... just build without it")
        p.VH = qd.ContainsKey("vh") ? Int(qd, "vh", 0, 0, 43) : 7 * Int(qd, "vk", 0, 0, 6); if (p.VH > 0 && p.VH < 5) p.VH = 5; p.WK = Int(qd, "wk", 0, 0, 4); p.BK = Int(qd, "bk", 0, 0, 3); p.UK = Int(qd, "uk", 0, 0, 3); p.IK = Math.Max(1, Int(qd, "ik", 1, 0, 3)); p.UAt = Pick(qd, "uat", UAts);
        p.VX = Int(qd, "vx", 0, -40, 40); p.VY = Int(qd, "vy", 0, -40, 40); p.UX = Int(qd, "ux", 0, -40, 40); p.UY = Int(qd, "uy", 0, -40, 40); p.IX = Int(qd, "ix", 0, -40, 40); p.IY = Int(qd, "iy", 0, -40, 40);
        p.FX = Int(qd, "fx", -1, -1, Cv.W - 1); p.FY = Int(qd, "fy", 0, 0, Cv.H - 1); p.FW = Int(qd, "fw", 0, 0, Cv.W); p.FH = Int(qd, "fh", 0, 0, Cv.H); if (p.FW < 1 || p.FH < 1) p.FX = -1;
        p.StIco = Pick(qd, "ico", StIcos); p.KAt = Pick(qd, "kat", KAts); p.KX = Int(qd, "kx", 0, -40, 40); p.KY = Int(qd, "ky", 0, -40, 40);
        object so; var sd = !qd.ContainsKey("#st") && qd.TryGetValue("st", out so) ? so as Dictionary<string, object> : null;   // (11-17 each state's own keys over the piece's: a piece of its own)
        if (sd != null)
            foreach (var kv in sd)
            {
                var od = kv.Value as Dictionary<string, object>; if (od == null || Array.IndexOf(Hs.StNames, kv.Key) < 0) continue;
                var own = new Dictionary<string, object>();
                foreach (var e in od) if (Array.IndexOf(StKeys, e.Key) >= 0 && e.Value != null && (e.Value is string || e.Value is bool || e.Value is int || e.Value is long || e.Value is double || e.Value is decimal)) own[e.Key] = e.Value;
                if (own.Count == 0) continue;
                var md = new Dictionary<string, object>(qd); md.Remove("st"); md["#st"] = true; foreach (var e in own) md[e.Key] = e.Value;
                if (own.ContainsKey("vk") && !own.ContainsKey("vh")) md.Remove("vh");   // (an old-style size of its own: not the piece's height)
                var q = Piece(md); if (q == null) continue;
                if (p.St == null) { p.St = new Dictionary<string, HsPiece>(); p.StRaw = new Dictionary<string, object>(); }
                p.St[kv.Key] = q; p.StRaw[kv.Key] = own;
            }
        return p;
    }
    static IEnumerable List(Dictionary<string, object> d, string k) { object o; return d.TryGetValue(k, out o) && o is IEnumerable && !(o is string) ? (IEnumerable)o : new object[0]; }
    static string Str(Dictionary<string, object> d, string k) { object o; if (!d.TryGetValue(k, out o) || !(o is string)) return null; var s = ((string)o).Trim(); return s.Length == 0 || s.Length > 200 ? null : s; }
    static double Num(Dictionary<string, object> d, string k)
    {
        object o; if (!d.TryGetValue(k, out o) || o == null) return double.NaN;
        double v; if (!double.TryParse(Convert.ToString(o, CultureInfo.InvariantCulture), NumberStyles.Float, CultureInfo.InvariantCulture, out v) || double.IsInfinity(v) || Math.Abs(v) > 1e9) return double.NaN;
        return v;
    }
    static bool Bool(Dictionary<string, object> d, string k, bool def) { object o; return d.TryGetValue(k, out o) && o is bool ? (bool)o : def; }
    static int Int(Dictionary<string, object> d, string k, int def, int lo, int hi)
    {
        object o; if (!d.TryGetValue(k, out o) || o == null) return def;
        double v; if (!double.TryParse(Convert.ToString(o, CultureInfo.InvariantCulture), NumberStyles.Float, CultureInfo.InvariantCulture, out v)) return def;
        int n = (int)Math.Round(v); return n < lo || n > hi ? def : n;
    }
    static string Pick(Dictionary<string, object> d, string k, string[] from) { var s = Str(d, k); return s != null && Array.IndexOf(from, s) >= 0 ? s : from[0]; }
    static string AnimKey(string k) { foreach (var a in Anims) if (a.Key == k) return k; return ""; }

    // ---- the picture on the base ----
    public static bool[,] Draw(HsInfo i) { lock (gate) return Hs.Draw(Grid(Showing(i.Now)), i).Px; }
    static HsGPage Showing(DateTime t)
    {
        if (focus >= 0 && focus < pages.Count && DateTime.UtcNow < focusTill) return pages[focus];
        // (each page's Shows: always, only while a game runs, only while none does. The ones that fit now take turns;
        // none fits: every page, so the screen is never left without one)
        bool g = false; try { g = Gaming(); } catch { }
        var ps = new List<HsGPage>();
        foreach (var pg in pages) if (pg.When == "always" || (pg.When == "game") == g) ps.Add(pg);
        if (ps.Count == 0) ps = pages;
        if (every <= 0 || ps.Count < 2) return ps[0];
        long s = (long)(t - new DateTime(2000, 1, 1)).TotalSeconds;
        return ps[(int)(s / every % ps.Count)];
    }
    // the animation he picked to start the page (start) or end it (null: none); one by its key (the popup's preview)
    public static HsAnim Anim(bool start) { return Find(start ? startKey : stopKey); }
    public static HsAnim Find(string k) { foreach (var a in Anims) if (a.Key == k) return a; return null; }

    // ---- the readings, every second from the dashboard (x-form.cs): the values of the readings on his pages, and a
    // history of each for the graphs (Hs.Extra, Hs.Hist; Hs.Units / Names / Maxes from the catalog) ----
    static Source fsrc; static int fver = -1; static readonly Dictionary<string, int> at = new Dictionary<string, int>();
    public static void Feed(Source s)
    {
        var i = Batt.Info(DateTime.Now);
        lock (gate)
        {
            var keys = new HashSet<string>();
            Action<HsGPage> want = pg => { foreach (var p in pg.Pieces) { if (p.Src != "clock") keys.Add(p.Src); if (p.Src2 != null) keys.Add(p.Src2); } };
            foreach (var pg in pages) want(pg);
            foreach (var t in themes) foreach (var pg in t.Pages) want(pg);   // (his themes' pictures in Customize draw real graphs too)
            foreach (var k0 in PresetKeys) keys.Add(k0);   // (the ready-made pages' and his saved pages' too: their pictures in Settings draw real graphs)
            foreach (var x in saved) want(x.Page);
            if (s != null && (s != fsrc || s.Version != fver)) { fsrc = s; fver = s.Version; at.Clear(); for (int k = 0; k < s.Readings.Count; k++) at[s.Readings[k].Key] = k; }
            foreach (var k in keys)
            {
                double v = double.NaN; int j;
                switch (k)
                {
                    case "cpu": v = i.Cpu; break;
                    case "gpu": v = i.Gpu; break;
                    case "head": v = i.HeadOff || i.Head < 0 ? double.NaN : i.Head; break;
                    case "spare": v = i.SpareOut || i.Spare < 0 ? double.NaN : i.Spare; break;
                    case "mouse": v = i.Mouse < 0 ? double.NaN : i.Mouse; break;
                    case "vol": v = i.Volume < 0 ? double.NaN : i.Volume; break;
                    default:
                        if (s != null && at.TryGetValue(k, out j) && j < s.Readings.Count)
                        {
                            var r = s.Readings[j];
                            if (j < s.Values.Length) v = s.Values[j];
                            Hs.Units[k] = Unit(r.Unit ?? ""); Hs.Names[k] = Caps(r.Label ?? "");
                            bool pct = r.Unit == "%" || r.Unit == Deg + "C";
                            Hs.Maxes[k] = pct ? 100 : Nice(j < s.Max.Length ? s.Max[j] : double.NaN);
                        }
                        Hs.Extra[k] = v; break;
                }
                if (double.IsInfinity(v)) v = double.NaN;
                double[] h;
                if (!Hs.Hist.TryGetValue(k, out h)) { h = new double[Keep]; for (int n = 0; n < Keep; n++) h[n] = double.NaN; Hs.Hist[k] = h; }
                Array.Copy(h, 1, h, 0, Keep - 1); h[Keep - 1] = v;
            }
            foreach (var k in new List<string>(Hs.Hist.Keys)) if (!keys.Contains(k)) { Hs.Hist.Remove(k); Hs.Extra.Remove(k); }
        }
    }
    static readonly string Deg = ((char)176).ToString();
    // the pixel fonts have capitals, digits and % : - ! only
    static string Caps(string s)
    {
        var b = new StringBuilder();
        // (an accented letter keeps its letter, 11-17: the accent goes, not the letter)
        var bare = new StringBuilder(); foreach (char c1 in (s ?? "").Normalize(NormalizationForm.FormD)) if (System.Globalization.CharUnicodeInfo.GetUnicodeCategory(c1) != System.Globalization.UnicodeCategory.NonSpacingMark) bare.Append(c1);
        foreach (char c0 in bare.ToString().ToUpperInvariant()) { char c = c0; if (!((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '%' || c == '-' || c == ':' || c == '.' || c == '/' || c == '!')) c = ' '; if (c == ' ' && (b.Length == 0 || b[b.Length - 1] == ' ')) continue; b.Append(c); }
        return b.ToString().TrimEnd();
    }
    static string Unit(string u) { return u == Deg + "C" ? Deg : u == "Mbit/s" ? "MBIT" : Caps(u).Replace(" ", ""); }
    // a bar's or ring's top for a reading with no top of its own: 1, 2 or 5 times a power of ten over the most it read
    static double Nice(double mx)
    {
        if (double.IsNaN(mx) || mx <= 0) return 100;
        double t = mx * 1.1, p = Math.Pow(10, Math.Floor(Math.Log10(t)));
        foreach (double f in new[] { 1.0, 2, 5, 10 }) if (f * p >= t) return f * p;
        return 10 * p;
    }

    // ---- the popup (x-form.cs: "x.hs.<what>", answered with "x.hsv") ----
    //   get  {page, cards}  the page n as it is now (and the animations' cards with cards); n shows on the base for 3 s
    //   set  {setup, page}  his change: taken, saved, and the page n back
    //   play {key, which, page}  one animation's pictures, 25 a second, for its card; the base plays it too
    static int galPage = -1, galN;
    public static Dictionary<string, object> Message(string what, Dictionary<string, object> m)
    {
        int n = Int(m, "page", 0, 0, MaxPages - 1);
        if (what == "set" && fileV <= 3)   // (a file from a newer HW Deck: read only)
        {
            object o; m.TryGetValue("setup", out o);
            lock (gate) Take(o as Dictionary<string, object>);
            Save();
        }
        if (what == "get" || what == "set")
        {
            var r = new Dictionary<string, object>();
            var i = Batt.Info(DateTime.Now); i.Dx = i.Dy = 1;   // (the preview stays put: the base's own moves a pixel a minute)
            lock (gate)
            {
                if (n >= pages.Count) n = pages.Count - 1;
                focus = n; focusTill = DateTime.UtcNow.AddSeconds(3);
                var pg = pages[n]; var L = Grid(pg);
                foreach (var q in L.Pieces) { q.AsNum = false; q.LabCut = false; q.DateCut = false; q.SecCut = false; }
                object pso; var psd = m.TryGetValue("pst", out pso) ? pso as Dictionary<string, object> : null; string pss = psd != null ? Str(psd, "s") : null; int psi = psd != null ? Int(psd, "i", -1, 0, 99) : -1;   // (11-17 the editor's preview of a state)
                var stnow = new List<object>(); foreach (var q in L.Pieces) { q.Force = null; stnow.Add(Hs.StateOf(i, q)); } r["stnow"] = stnow;
                if (pss != null && psi >= 0 && psi < L.Pieces.Count && (Array.IndexOf(Hs.StNames, pss) >= 0 || pss == "norm")) { L.Pieces[psi].Force = pss; r["pst"] = new Dictionary<string, object> { { "i", psi }, { "s", pss } }; }
                var plog = new List<object[]>(); bool[,] px; Hs.PartLog = plog; try { px = Hs.Draw(L, i).Px; } finally { Hs.PartLog = null; foreach (var q in L.Pieces) q.Force = null; }   // (11-16 its parts' boxes)
                Func<double, double> F = v => Math.Round(v, 5);
                var rects = new List<object>();   // (each piece, in the page's own order: null when it found no room)
                foreach (var p in L.Pieces) rects.Add(p.X < 0 ? null : new object[] { F((p.Bx + 1) / 128.0), F((p.By + 1) / 64.0), F(p.Bw / 128.0), F(p.Bh / 64.0) });
                var colx = new List<object>(); for (int c = 0; c < L.Cols; c++) colx.Add(new object[] { F((L.ColX[c] + 1) / 128.0), F(L.ColW[c] / 128.0) });
                var rowy = new List<object>(); for (int rr = 0; rr < L.Rows; rr++) rowy.Add(new object[] { F((L.RowY[rr] + 1) / 64.0), F(L.RowH[rr] / 64.0) });
                r["parts"] = Hs.PartsReply(L.Pieces, plog); r["wkmax"] = Hs.WkReply(L.Pieces, plog); r["vhmax"] = Hs.TagReply(L.Pieces, plog, "#vhmax"); r["bkmax"] = Hs.TagReply(L.Pieces, plog, "#bkmax"); r["img"] = Bits(px); r["rects"] = rects; r["colx"] = colx; r["rowy"] = rowy;
                var asnum = new List<object>(); foreach (var p in L.Pieces) asnum.Add(p.AsNum); r["asnum"] = asnum; var labcut = new List<object>(); foreach (var p in L.Pieces) labcut.Add(p.LabCut); r["labcut"] = labcut; var ccut = new List<object>(); foreach (var p in L.Pieces) ccut.Add(p.Src != "clock" ? "" : (p.DateCut ? "d" : "") + (p.SecCut ? "s" : "") + (p.LabCut ? "l" : "")); r["clockcut"] = ccut;   // (11-17 what a clock left out, no room)   // (dials drawn as numbers: the panel shows them a number's options, 11-15)
                r["readonly"] = fileV > 3;
                // (the page's layout presets, its digits in the four designs, the bar looks, the tiles: pictures for Customize's
                // galleries; not every second, the base's knob waits on this lock: on a change, another page, and each 5th ask)
                bool gal = what == "set" || Bool(m, "cards", false) || n != galPage || ++galN % 5 == 0; galPage = n;
                if (gal) {
                r["icodef"] = IconDefaults();
                var lay = new List<object>();
                foreach (var kv in Layouts(pg)) lay.Add(new Dictionary<string, object> { { "name", kv.Key }, { "img", Bits(Hs.Draw(Grid(kv.Value), i).Px) }, { "page", PageDict(kv.Value) } });
                r["lay"] = lay;
                var dpg = new HsGPage { Rows = 1, Cols = 1 }; dpg.Pieces.Add(P("head", "number", 1, "off")); var di = new HsInfo { Now = i.Now, Dx = 1, Dy = 1, Head = 62 };   // (11-15 his "they shouldn't look the same": each design as one big number, not his page shrunk)
                var dig = new List<object>(); for (int k = 0; k < 4; k++) dig.Add(Bits(Zoom2(Hs.Draw(Grid(dpg, k, bar), di).Px)));
                r["dig"] = dig;
                HsGPage bp = null; foreach (var x in Presets()) if (x.Key == "bars") bp = x.G;
                if (bp != null) r["bars"] = new List<object> { Bits(Hs.Draw(Grid(bp, digits, "blocks"), i).Px), Bits(Hs.Draw(Grid(bp, digits, "solid"), i).Px) };
                }
                r["what"] = what; r["setup"] = Setup(); r["page"] = n;
                var an = new List<object>(); foreach (var a in Anims) an.Add(new Dictionary<string, object> { { "key", a.Key }, { "name", a.Name } });
                r["anims"] = an;
                var pre = Templates();   // (the Pages gallery: the ready-made themes' pages, 11-15)
                if (gal) {
                var pimg = new Dictionary<string, object>(); foreach (var x in pre) { var gl = Grid(x.G, x.Dig, x.BarLook); gl.Icons = x.Icons; pimg[x.Key] = Bits(Hs.Draw(gl, i).Px); }   // (in its theme's look)
                var simg = new Dictionary<string, object>(); foreach (var x in saved) simg[x.Id] = Bits(Hs.Draw(Grid(x.Page), i).Px);
                var timg = new Dictionary<string, object>(); foreach (var t in themes) { var tl = Grid(t.Pages[0], t.Digits, t.Bar); tl.Icons = t.Icons; timg[t.Id] = Bits(Hs.Draw(tl, i).Px); }   // (his themes: their first page in their own look)
                var rimg = new Dictionary<string, object>(); foreach (var t in Ready()) { var rl0 = Grid(t.Pages[0], t.Digits, t.Bar); rl0.Icons = t.Icons; rimg[t.Id] = Bits(Hs.Draw(rl0, i).Px); }
                r["pimg"] = pimg; r["simg"] = simg; r["timg"] = timg; r["rimg"] = rimg;
                }
                if (Bool(m, "cards", false))
                {
                    var cards = new Dictionary<string, object>();
                    var cpx = pss != null ? Hs.Draw(L, i).Px : px;   // (11-17 the cards from the page as it reads, not the state looked at: the review)
                    foreach (var a in Anims) { cards[a.Key + "-start"] = Bits(a.Start(a.StartMs * 0.45, cpx)); cards[a.Key + "-stop"] = Bits(a.Stop(a.StopMs * 0.45, cpx)); }
                    r["cards"] = cards;
                    var pl = new List<object>();
                    foreach (var x in pre) pl.Add(new Dictionary<string, object> { { "key", x.Key }, { "name", x.Name }, { "group", x.Group }, { "page", PageDict(x.G) } });
                    r["presets"] = pl;
                    var rl = new List<object>();
                    foreach (var t in Ready()) rl.Add(new Dictionary<string, object> { { "key", t.Id }, { "name", t.Name }, { "theme", ThemeDict(null, null, t.Pages, t.Every, "", "", t.Digits, t.Bar, t.Icons) } });
                    r["rthemes"] = rl;
                }
            }
            return r;
        }
        if (what == "play")
        {
            var a = Find(Str(m, "key")); if (a == null) return null;
            bool start = Str(m, "which") != "stop";
            if (!Bool(m, "here", false)) Batt.Preview(a, start);   // (here: the Headset tab's picture as the screen switches, 11-15; else the base plays it too, when it shows his page: his 11-12 "no animations")
            var i = Batt.Info(DateTime.Now); i.Dx = i.Dy = 1;
            var frames = new List<object>();
            lock (gate)
            {
                if (n >= pages.Count) n = pages.Count - 1;
                var px = Hs.Draw(Grid(pages[n]), i).Px;
                int len = start ? a.StartMs : a.StopMs;
                for (int t = 0; t < len; t += 40) frames.Add(Bits(start ? a.Start(t, px) : a.Stop(t, px)));
                frames.Add(Bits(start ? a.Start(len, px) : a.Stop(len, px)));
                if (!start) { frames.Add(Bits(new bool[128, 64])); frames.Add(Bits(new bool[128, 64])); }   // (a moment of black, then the card's own picture)
            }
            return new Dictionary<string, object> { { "play", new Dictionary<string, object> { { "key", a.Key }, { "which", start ? "start" : "stop" }, { "ms", 40 }, { "frames", frames }, { "here", Bool(m, "here", false) } } } };
        }
        return null;
    }
    // a picture for the page: 128 x 64 bits, row by row, the first pixel the highest bit, as base64
    // (11-15: a picture's lit part twice as big, the middle 64 x 32 pixels around it each drawn 2 x 2; as it is when it doesn't fit)
    static bool[,] Zoom2(bool[,] px)
    {
        int x0 = 128, y0 = 64, x1 = -1, y1 = -1;
        for (int y = 0; y < 64; y++) for (int x = 0; x < 128; x++) if (px[x, y]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
        if (x1 < 0 || x1 - x0 > 61 || y1 - y0 > 29) return px;
        int cx = Math.Max(0, Math.Min(64, (x0 + x1 + 1) / 2 - 32)), cy = Math.Max(0, Math.Min(32, (y0 + y1 + 1) / 2 - 16));
        var o = new bool[128, 64];
        for (int y = 0; y < 64; y++) for (int x = 0; x < 128; x++) o[x, y] = px[cx + x / 2, cy + y / 2];
        return o;
    }
    static string Bits(bool[,] px)
    {
        var b = new byte[128 * 64 / 8];
        for (int y = 0; y < 64; y++) for (int x = 0; x < 128; x++) if (px[x, y]) { int k = y * 128 + x; b[k >> 3] |= (byte)(0x80 >> (k & 7)); }
        return Convert.ToBase64String(b);
    }
}

// The headset's and the mouse's batteries, read by the dashboard itself (no SteelSeries GG, no Logitech G HUB), and the
// headset base station's small screen showing the dashboard (11-12, his "looks amazing start working" after the screen
// test). Protocol and proof: memory note re-headset-mouse; the proof reader with the same classes and the same gates is
// Code\projects\hwdeck\local\batteries\batteries.cs.
//   headset  Arctis Nova Pro Wireless base station, USB 1038:12E0, HID interface 4, which Windows splits by report id:
//            FFC0 collection = report 06: questions 06 B0 / 06 B7 and their replies, and the screen (feature 06 93
//            draws, output 06 95 gives the base its own view back); FF00 collection = report 07, what the base pushes
//   mouse    LIGHTSPEED receiver, USB 046D:C54D, HID interface 2, HID++ (short 10 on FF00/0001, long 11 on FF00/0002)
// Every packet leaves through one of four gates (Arctis.Out, Arctis.Feature, Arctis.Raw for the volume knob, Lightspeed.Call): status questions (06 B0,
// 06 B7, 06 20, 06 10, 06 80; HID++ ping, getFeature, 1004 getStatus), the two screen commands, and the volume knob's own reports (gate 4) only. NEVER add: 06 09 (save to flash), 06 01 (reset), any 06 <setting> write (EQ 33 / 2E,
// sidetone 39, mic 37, gain 27, BT B2 / B3, timer C1, mode C3, LED BF, ANC BD / B9, home view 89), 06 85 (the screen's
// brightness, a setting the base keeps), and on the mouse any HID++ "set" function or receiver register write (80 / 82).
// What the screen shows is drawn by x-hspage.cs (free to redesign); this file decides when. The screen is an OLED and
// burns in (his 11-12; 11-13 he saw it on a white picture): the page moves by a pixel every minute over 3 x 3 places,
// and goes dark (every pixel off) while the PC is locked, after 2 minutes with nobody at it (not while a game runs),
// while Windows has the monitors off, as it goes to sleep and as Windows shuts down (or, his setting, the base's own
// view comes back then). The base's own view comes back (06 95) only when he switches the screen off in
// Controls, when the dashboard quits, or while SteelSeries GG runs (the screen is GG's then), and for a moment on
// every click of the base's volume knob, with our picture right after it, where its knob can't be taken over: there the only way past the base's own volume
// screen (see volume below). A test copy (--data or --fake) reads nothing (HWDECK_BATT=1 lets one, for its own check).

// ---- the headset's battery as a percent (11-17, hwdeck\local\hs-battery-1117\findings.md) ----
// The base station hands out 9 steps only (06 b0 / 06 b7, 0 to 8). Its firmware (1.29.27, 0xcd70) cuts the voltage the
// headset sends it: 0 = 3.60 V or less, 1 to 3.70, 2 to 3.75, 3 to 3.78, 4 to 3.82, 5 to 3.88, 6 to 3.95, 7 to 4.05,
// 8 above, and keeps nothing finer. GG shows a step as step x 12.5 %, but the steps are far from equal: Hours is how
// long the headset stayed on each (three logged runs of his two batteries, within a tenth of each other, about 25 h
// in all). So "12%" covered 28% down to 2% of the running time (6.6 h), and "0%" is the last half hour, where the
// headset's own beeps start. The percent here is the share of the running time left: a step's start, counted down by
// the time the headset has been on since, never past the step's end; every real step puts it right again (the
// backtest over the three runs: at most 3 points off at a step, where step x 12.5 jumped 12 or 13 every time).
// While discharging the base only lets its step go down, and takes the first reading after the headset connects as
// it is, so after a rest it can read one step higher for a few minutes; on the cable only up.
static class HeadEst
{
    public static readonly double[] Hours = { 0.5, 6.65, 4.68, 1.51, 1.11, 2.78, 3.16, 3.44, 1.72 };   // on step 0 .. 8
    public const int Low = 2;                  // step 0 shows 2, then 1: the headset's own beeps start with it
    static readonly double[] top = new double[9], end = new double[9];   // the share of the running time left as a step starts and ends, percent
    public static int Step = -1;               // the step counted on: the lowest this battery has shown (-1: no battery seen yet)
    public static double Sec;                  // seconds the headset has been on, on that step
    static long at = -1;                       // the clock of the reading before, ms (-1: nothing to count from)
    static double upSec;                       // seconds it has read one step higher than Step
    static long spareOut = -1;                 // when the spare's slot went empty, ms (-1: not since the last new battery)
    static int lastSpare = -1;
    static bool off = true, cable, full;       // the reading before: the headset off; on its cable; full on its cable

    static HeadEst()
    {
        double all = 0; foreach (double h in Hours) all += h;
        double left = all;
        for (int s = 8; s >= 0; s--) { top[s] = 100 * left / all; left -= Hours[s]; end[s] = Math.Max(0, 100 * left / all); }
    }
    static int R(double x) { return (int)Math.Round(x, MidpointRounding.AwayFromZero); }

    // the most and the least a step shows: never a number of the step under it, so every real step is seen and 2 or
    // less is step 0 alone
    public static int Most(int step) { return step >= 8 ? 100 : R(top[step]); }
    public static int Least(int step) { return step <= 0 ? 1 : R(top[step - 1]) + 1; }

    public static int Pct()
    {
        if (Step < 0) return -1;
        double f = Math.Min(1.0, Sec / (Hours[Step] * 3600));
        return Math.Max(Least(Step), Math.Min(Most(Step), R(top[Step] - (top[Step] - end[Step]) * f)));
    }

    // one reading of the base: the headset's step, the spare's (0: its slot empty), the headset's power (1 off, 2
    // charging on its cable, 4 full on its cable, anything else on) and the clock in ms. The percent to show (-1: off)
    public static int Feed(int level, int spare, int power, long now)
    {
        if (spare == 0 && lastSpare > 0) spareOut = now;   // (the spare taken out: a swap, if the headset comes on within 10 min)
        if (spare >= 0) lastSpare = spare;
        if (power == 1) { off = true; at = -1; return -1; }   // (off: nothing counts, the step and its time keep)
        if (level < 0 || level > 8) return Pct();
        if (power == 2 || power == 4)   // (on its cable: no counting; the step's end, the base only lets it go up there)
        {
            cable = true; full = power == 4; off = false; at = -1; Step = level; Sec = 0; upSec = 0;
            return full ? 100 : Math.Max(1, R(end[level]));
        }
        // a swap: the headset comes back on within 10 min of the spare leaving its slot, on another step (the same
        // step: the spare was only taken out and put back, his 11-12 21:59)
        bool swapped = off && spareOut >= 0 && now - spareOut < 600000 && level != Step;
        long dt = at >= 0 ? now - at : 0; if (dt < 0 || dt > 300000) dt = 0;   // (a hole of over 5 min, the PC asleep: not counted)
        at = now; off = false;
        if (Step < 0 || cable || swapped || level >= Step + 2)
        {
            // a battery not seen before: at step 8 from the charger's slot (or off a full cable) it is full; anything
            // else is somewhere on its step, taken as the middle
            Step = level; Sec = level == 8 && (swapped || full || dt > 0) ? 0 : Hours[level] * 1800; upSec = 0; spareOut = -1;
        }
        else if (level == Step + 1)
        {
            // one step up: the voltage came back after a rest. Counted on the lower step; half an hour of it means a
            // battery with more in it after all
            upSec += dt / 1000.0;
            if (upSec >= 1800) { Step = level; Sec = Hours[level] * 1800; upSec = 0; } else Sec += dt / 1000.0;
        }
        else if (level < Step)
        {
            // a step down: seen as it happened (a reading a moment before) it starts now; found later, its middle
            bool seen = dt > 0 && level == Step - 1;
            Step = level; Sec = seen ? 0 : Hours[level] * 1800; upSec = 0;
        }
        else { Sec += dt / 1000.0; upSec = 0; }
        cable = full = false;
        return Pct();
    }

    // kept across a restart of the app (headbatt.txt in the data folder): the step and its seconds
    public static string State() { return "head " + Step + " " + (long)Sec; }
    public static void Load(string s)
    {
        var w = (s ?? "").Trim().Split(' '); int st; long sc;
        if (w.Length >= 3 && w[0] == "head" && int.TryParse(w[1], out st) && long.TryParse(w[2], out sc) && st >= 0 && st <= 8 && sc >= 0) { Step = st; Sec = sc; }
    }
    public static void Reset() { Step = -1; Sec = 0; at = -1; upSec = 0; spareOut = -1; lastSpare = -1; off = true; cable = full = false; }
}

static class Batt
{
    public static Action<string> Log = delegate { };
    public static Action Changed = delegate { };    // what the headset's state shows changed (HW Dashboard's Controls card)
    public static Func<bool> Blocked = () => false;   // a copy that must never open the devices
    public static bool MouseOn;   // the LIGHTSPEED mouse too: HW Dashboard only (his 11-13: not for HW Deck users), set before Start (HW Dashboard's test and trial copies)
    public static string ScreenFile;                 // hs-screen.txt in the data folder: "on" his pages (Custom), "base" the base's own screen (Original), "dark" (Off); "off" (before 11-14): dark in HW Dashboard, the base's own in HW Deck; none: the base's own
    public static string StateFile;                  // batt.txt in the data folder: the mouse's last reading (a start while it sleeps showed "--")
    // what was read (-1: not known). The levels are the base's steps, 0 to 8: the spare's shown as GG does (0, 12 .. 100 %),
    // the headset's own as HeadPct, the share of its running time left (HeadEst, 11-17)
    public static volatile int HeadLevel = -1, SpareLevel = -1, HeadPower = -1, MousePct = -1, MouseCharging = -1;
    public static volatile int HeadPct = -1;          // the headset's battery as shown, percent (-1: off or not read yet)
    public static volatile bool HeadThere, MouseThere, MouseAsleep;
    // found at least once in this run: HW Deck's readings for them are in its list from then on (as the 12V-2x6
    // connector's are only for a card that reports its pins), so nobody without this headset or mouse sees them
    public static volatile bool HeadSeen, MouseSeen;
    public const string HeadKey = "hwdeck.0/headbatt", SpareKey = "hwdeck.0/sparebatt", MouseKey = "hwdeck.0/mousebatt";
    // the spare's slot is read as empty when the base says level 0: that is what it said with the battery taken out
    // (his 11-12). No flag of its own is known yet; the base's answers are logged on every change ("base said") to find one
    public static bool SpareOut { get { return SpareLevel == 0; } }
    public static bool SpareCharging { get { return SpareLevel > 0 && SpareLevel < 8; } }   // (the base charges what is in its slot)
    // the dashboard's own numbers for the page, every second (Feed)
    public static double Cpu = double.NaN, Gpu = double.NaN;
    public static volatile bool Gaming;
    // the screen: switched on in Controls; what it shows now (none, off, gg, base, dark, page) and why it is dark
    public static volatile bool ScreenOn;
    public static volatile bool ScreenBase;          // ScreenOn false: true the base's own screen and knob (Original, his 11-14 "allow it to return to the old ui"), false dark (Off)
    public static volatile bool DisplaysOff;          // Windows turned the monitors off (the form's display state notice): dark, game or not
    const int AwaySec = 120;                          // nobody at the PC this long: dark (was 10 min; his 11-13 "dark sooner")
    static volatile string mode = "", darkWhy = "";
    static volatile bool locked, asleep, ending;
    static int endingAt;
    // the base's volume, 0 to 100: asked with 06 20 (its answer's [3]) every minute, and pushed as the knob turns
    // (07 25 <x>); both 0x38 - x, 0 to 56 (ggoled, Arctis Sound Manager; 15 pushes a turn, seen 11-12). Left to itself
    // the base answers every click with its own volume screen: it takes the screen back, drops every picture for 5 s
    // and shows its home view (its firmware: "if the host owns the screen, take it back", nothing else is checked).
    // 06 95 and our picture right after end that at once, but its screens still show for about 40 ms a click: that is
    // the way for a firmware this was not proven on, for its other home view, and for the headset's own wheel.
    // THE KNOB WITH NONE OF THE BASE'S SCREENS (11-13, his "the goal is perfection. 0 old ui"; read from the firmware
    // GG keeps on disk, checked by independent readers, proven on his base: hwdeck\local\hs-knob-1112, findings.md):
    //   - 06 1b 81 01 01 is the firmware's key test mode: it then only REPORTS the knob and the two buttons to the PC
    //     (06 b1 81 01 <key> <state>: key 3 / 4 a click up / down, 1 the knob pressed, 2 the back button) and does
    //     nothing with them. Memory only; 06 1b 81 01 00, or a replug, ends it.
    //   - the PC sets the volume itself: 06 25 <0x38 - level>. The base then draws its volume gauge once (no take back).
    //   - 06 1b 8a 01 <b> passes one byte to the OLED's controller (an SSD1309 kind: its start up sequence begins
    //     fd 12). fd 16 locks it: it ignores every command and every picture write and keeps showing what it has;
    //     fd 12 unlocks. So: lock, 06 25, wait for the gauge to be over, unlock, our picture. The gauge never shows.
    //   - a byte sent while the base is busy with its display is DROPPED with no sign, so every lock and unlock waits
    //     (busFree), and the unlock goes three times. No picture while locked: the base sends the panel its window
    //     only when it differs from the last one it sent. Never another byte through 06 1b 8a.
    //   - the gauge also lands in the base's copy of our picture (columns 75 to 127): the right half is always sent
    //     after a change. Its other home view draws the gauge over both halves: not handled, so that view keeps the
    //     old way.
    //   - THE HEADSET'S OWN WHEEL (his 11-13 pick "Build quiet wheel"): its clicks reach the base as a volume message,
    //     and the base takes the screen back for one only while the screen is the host's (every 06 93 makes it so,
    //     06 95 00 makes it the base's again). So between pictures the panel stays locked and the screen is handed
    //     back (06 95 00, its home frame goes to the locked panel): a wheel click then draws nothing. A picture: the
    //     left half while still locked (into the base's copy only), the panel unlocked, the right half (the base sends
    //     the panel its whole copy), locked again once the base's display is surely free, 06 95 00. Before the panel
    //     opens the volume is asked: a click in the locked part stops it there. Only in the open 45 ms or so can a
    //     click reach the panel: so while the wheel turns nothing is drawn, the number comes once it has rested
    //     QuietMs; a click that may have met the open moment is cleaned up (locked again, handed back) and drawn
    //     sooner. The base's own dimming can't reach a locked panel; his brightness slider ends the hold first. The
    //     base knob's first click goes through the open moment, the rest of its turn the way above, held again once it
    //     has rested. On wherever the knob mode works (11-14, his pick A; 11-13 it had scrambled the panel within
    //     minutes, the cause fixed in Hold, and the re-anchor in Open undoes a shifted write pointer). The Headset
    //     tab's "Faster volume wheel" picks the faster timing (experimental); its Refresh button sets the screen up again.
    //   - a button on the base while the mode is on: ignored (his 11-14 "BLOCK THESE COMMANDS FULLY": a knob press or
    //     the headset wheel's double click gave the base its own menus for 20 s); its menus work with the mode off.
    //     Every way out switches the mode off and unlocks: the screen switched
    //     off, GG, sleep, shutdown, quit, the base lost, an error nobody caught (OnCrash); and every connect cleans up
    //     after a run that died. A kill or a power cut leaves the knob dead (and the panel frozen if it fell inside
    //     the 80 ms of a lock) until the app runs again or the base is replugged.
    public static bool KnobZero = true;              // false (or hs-knob.txt = "off" beside hs-screen.txt): the old way for everyone (the clean up at connect still runs)
    const string KnobFirmware = "0001.029.027";      // the base's own firmware (1.29.27) in its answer to 06 10: read from and proven on this one only
    const int PassMs = 40, GaugeMs = 45, HandMs = 20000;   // the base's display busy after a picture half, and from 06 25 to the end of its gauge (14 ms was too short: the unlock was dropped, his 11-13 "the percentage didnt move"); a button's hand over
    static bool knobOk, knobFw, knobAsked, knobClean, knobMode, knobWasOn, knobSoon, panelLocked, basePressed, firstHold; static string knobWhy = "";
    static int knobLevel = -1, knobClicks, knobTries;   // the base's volume 0 to 56 as last read or set; clicks reported, not applied yet; its firmware asked and not answered
    static long busFree, handUntil, firstHoldUntil;  // Ms() when the base's display is free again; the base has its own screens until then; no picture before the first questions until then
    static byte[] sentLeft, sentRight;               // the two halves the base has of our picture (null: not ours, or not known)
    public static bool OffIsBlack;                    // HW Dashboard (set by the fork): the Headset screen switched off, "all off" and the app quitting show a BLACK screen, never the base's own view (his 11-14 "when I mean shut down the deck i mean show on the screen ONLY BLACK not the old ui"). HW Deck: switched off = the base's own view
    static volatile bool allOff; static uint allOffTick;   // his "all off" ran: dark until all on, or until he is back (input 5 s after it), his 11-14 "the headset deck didnt turn off when i ran all-off script"
    public static void AllOff(bool on) { allOff = on; var li = new uint[] { 8, 0 }; allOffTick = GetLastInputInfo(li) ? li[1] : unchecked((uint)Environment.TickCount); lastSec = -1; Log("headset screen: all " + (on ? "off: dark" : "on")); }
    static bool AllOffNow() { if (!allOff) return false; var li = new uint[] { 8, 0 }; if (GetLastInputInfo(li) && unchecked(li[1] - allOffTick) > 5000 && unchecked(li[1] - allOffTick) < 0x80000000u) { allOff = false; return false; } return true; }   // (input after it, past the click that ran it: he is back)
    public static bool WheelQuiet = false;           // set by WheelMode: always on since 11-14 (before: hs-wheel.txt = "on"; off 11-13 21:2x to 11-14, when the hold scrambled the base's panel within minutes, cured by a replug)
    const int HitQuietMs = 300, HomeMs = 90;          // after a click that may have met a picture; from 06 95 00 to the end of the base's home draw
    static int QuietMs = 700;                        // held: the wheel rested this long, its number drawn. His pauses inside one go are 200 to 650 ms, so shorter puts pictures inside his goes: a faster number, more flashes (his 11-14 "the delay is HORRENDOUS": try shorter). Set by WheelMode: 200, or 30 with the faster wheel
    static bool wheelSet, wheelFastNow;              // the wheel mode set from the Headset tab's switch (WheelMode), and which
    static int HeldPassMs = 40;                       // (26 from the 05:37 trim to 06:07: back to 40, a lock pair at a pass END is the one firmware-proven break path, board 065630 R4)
    const int HeldPassMsTrim = 26;                       // held: from the right half's send to the lock. The firmware's pass: 8 rows of 128 bytes over SPI at 400 kHz, 20.5 ms plus 8 event hops, rows chained in one handler so a lock sent during it is dropped whole (board wheel-1114, route S review). PassMs (40) left about 15 ms of open panel per picture for nothing: about 20 % of the flashes (the trim, his 11-14 "Yes, trim it")
    static int HeldEveryMs = 1000;                   // held: his page's own changes drawn at most this often (1000: every second, as unheld). Each change opens the panel about 60 ms: every 1 s about 1 go in 16 can start on it, 2 s 1 in 32, 5 s 1 in 80 (11-14)
    static long heldAt;                              // when a picture last went through the open moment
    static bool held, wheelHit, wheelOwed; static int holdFails;   // panel locked + screen the base's; a wheel click came within the open moment; its number not drawn yet
    static byte[] heldL, heldR;                      // the halves the locked panel shows (null: not known, maybe the base's frame)
    static long wheelAt = -100000, turnAt = -100000, openTo;   // the wheel's last click; the base knob's last turn; a push until then may be a click that met the open moment
    static volatile int volume = -1; static long fastUntil, drawnAt, knobAt = -100000;
    static int Vol(byte x) { return Math.Max(0, Math.Min(100, (0x38 - x) * 100 / 0x38)); }

    static Thread th, mt; static volatile bool stop;
    static readonly object hl = new object();   // the headset's handle: its loop, and Windows' power and session events
    static Arctis head; static Lightspeed mouse;
    static bool drew, lastDark, paged; static long darkAt, headLook, headAsk, mouseLook, mouseAsk, ggLook; static int sendFails, lastSec = -1;   // (paged: the base shows his page now, so a shut down animation has a page to leave)
    static bool gg, headSeen; static byte mDev, mIdx; static string lastSaid = "";
    static readonly Stopwatch clock = Stopwatch.StartNew();
    static long Ms() { return clock.ElapsedMilliseconds; }

    public static void Start()
    {
        if (th != null) return;
        string sf = ""; try { if (ScreenFile != null && File.Exists(ScreenFile)) sf = File.ReadAllText(ScreenFile).Trim(); } catch { }
        ScreenOn = sf == "on"; ScreenBase = sf == "base" || sf == "" || (sf == "off" && !OffIsBlack);   // (the base's own screen until Custom is picked in the Headset tab; ExtStart has set OffIsBlack by now)
        try { if (ScreenFile != null) { string kf = Path.Combine(Path.GetDirectoryName(ScreenFile), "hs-knob.txt"); if (File.Exists(kf) && File.ReadAllText(kf).Trim() == "off") KnobZero = false; } } catch { }
        WheelMode();
        try
        {
            var w = StateFile != null && File.Exists(StateFile) ? File.ReadAllText(StateFile).Split(' ') : new string[0];
            int p, c;
            if (w.Length >= 3 && w[0] == "mouse" && int.TryParse(w[1], out p) && int.TryParse(w[2], out c) && p >= 0 && p <= 100) { MousePct = p; MouseCharging = c; }
        }
        catch { }
        try { string ef = EstFile(); if (ef != null && File.Exists(ef)) HeadEst.Load(File.ReadAllText(ef)); } catch { }   // (the headset's step and its time so far, 11-17)
        SystemEvents.SessionSwitch += OnSwitch; SystemEvents.PowerModeChanged += OnPower; SystemEvents.SessionEnding += OnEnding; AppDomain.CurrentDomain.UnhandledException += OnCrash;
        stop = false;
        th = new Thread(HeadLoop) { IsBackground = true, Name = "headset" };
        if (MouseOn) mt = new Thread(MouseLoop) { IsBackground = true, Name = "mouse" };   // (its own: a sleepy mouse answers in up to 1 s, the knob can't wait)
        th.Start(); if (mt != null) mt.Start();
    }

    // the dashboard quits: the base gets its own view back, but stays dark when Windows is ending (the PC goes off)
    public static void Stop()
    {
        if (th == null) return;
        SaveEst(Ms());
        try { SystemEvents.SessionSwitch -= OnSwitch; SystemEvents.PowerModeChanged -= OnPower; SystemEvents.SessionEnding -= OnEnding; AppDomain.CurrentDomain.UnhandledException -= OnCrash; } catch { }
        stop = true;
        lock (hl)
        {
            if (head != null)
            {
                try { if (knobMode || knobFw) Knob(false); } catch { }   // (the knob is the base's own again; on the proven firmware always, in case an off was lost)
                try { if (ending && ScreenOn && !gg) Dark(); else { if (paged && ScreenOn && !gg) Play(HsPage.Anim(false), false, HsPage.Draw(Info(DateTime.Now))); if (drew) { if (OffIsBlack && !gg) Dark(); else head.ScreenBack(); } } } catch { }   // (quitting: his shut down animation first; HW Dashboard: then black, not the base's own view, 11-14)
                head.Dispose(); head = null;
            }
        }
        th.Join(2000); th = null;
        bool mouseDone = mt == null || mt.Join(3000); mt = null;   // (a mouse call waits up to 2.5 s)
        if (mouseDone && mouse != null) { try { mouse.Dispose(); } catch { } mouse = null; }   // (still in a call: left to the exit, not freed under it, the review 11-12)
    }

    public static void FakeHeadset(string how = "1")
    {
        HeadSeen = HeadThere = true; HeadLevel = 5; SpareLevel = 8; HeadPower = 0; HeadPct = 62;
        foreach (var w in (how ?? "").Split(',')) { var t = w.Trim(); if (t == "spare0") SpareLevel = 0; else if (t == "off") HeadPower = 1; else if (t == "chg") HeadPower = 2; else if (t == "low") { HeadLevel = 0; HeadPct = HeadEst.Low; } else if (t.StartsWith("pct")) { int fp; if (int.TryParse(t.Substring(3), out fp) && fp >= 0 && fp <= 100) HeadPct = fp; } }   // (a test copy's states, 11-16: an empty spare slot, the headset off or charging)
        if (MouseOn) { MouseSeen = MouseThere = true; MousePct = 87; MouseCharging = 0; }
        SetFake();         volume = 45; Brightness = 3; knobFw = true;   // (a --fake copy's Headset tab shows the wheel switch, as on his base)
    }

    // ---- the headset's own settings (11-15, hwdeck\local\hs-settings-1115\findings.md; his "allow control of the headset
    // settings (the basic ones, like timeouts, simple eq, volume, mic, etc.)", pick A + save): read from the 06 b0 and 06 20
    // answers ([8] transparency, [9] mic muted, [10] noise control, [11] mute light, [12] auto off; [4] gain, [6] EQ preset,
    // [7..16] the custom bands, [17] mic volume, [18] sidetone). A change is queued and sent between the knob's work, 50 ms
    // apart (GG's gap), read back, and kept in the base's storage with one 06 09 2 s after the last one (the base saves
    // by itself only after a wheel or menu change). None of them draws on the base's screen (each redraws only when the
    // base's own menu is open on it); the volume does, so it goes through the knob's own way. GG running: nothing sent ----
    sealed class HsSet { public int nc, tr, eq, gain, mic, st, light, off, muted; public int[] bands = new int[10]; }
    static HsSet hset;                                   // what the base said, or what he set since; null: not known
    static readonly object setLk = new object();
    static readonly List<byte[]> setQ = new List<byte[]>();   // his changes still to send (the newest of each wins)
    static volatile int volWant = -1;                    // the volume slider: a level 0..56
    static long setNext, setReadAt, setSaveAt, setLook = -100000, setWrote = -100000; static bool setDirty, setOwed;
    static volatile bool setRo;                          // a base whose firmware was not read (the Xbox ones): shown, not changed
    static int setLvlMem = -1;                           // a copy with no base (--fake): the volume set here, the knob's own level untouched

    // the Headset tab: a setting changed (real false: a --fake copy's, kept in memory only)
    public static void Setting(Dictionary<string, object> m, bool real)
    {
        object ko, vo, io; int v, i = 0;
        if (m == null || !m.TryGetValue("k", out ko) || !m.TryGetValue("v", out vo) || !int.TryParse(Convert.ToString(vo, System.Globalization.CultureInfo.InvariantCulture), out v)) return;
        string k = ko as string;
        if (k == "band" && (!m.TryGetValue("i", out io) || !int.TryParse(Convert.ToString(io, System.Globalization.CultureInfo.InvariantCulture), out i))) return;
        lock (setLk)
        {
            var s = hset; if (s == null) return;
            if (real && (gg || mode == "gg" || setRo)) return;   // (GG has the base, or a base not read: shown only)
            byte[] r;
            if (k == "vol") { if (v < 0 || v > 0x38) return; if (real) volWant = v; else setLvlMem = v; }
            else if (k == "nc" && v >= 0 && v <= 2) { s.nc = v; r = new byte[] { 0x06, 0xBD, (byte)v }; if (real) SetQueue(r); }
            else if (k == "tr" && v >= 1 && v <= 10) { s.tr = v; r = new byte[] { 0x06, 0xB9, (byte)v }; if (real) SetQueue(r); }
            else if (k == "eq" && v >= 0 && v <= 4) { s.eq = v; r = new byte[] { 0x06, 0x2E, (byte)v }; if (real) SetQueue(r); }
            else if (k == "band" && i >= 1 && i <= 10 && v >= 0 && v <= 40)   // (a band plays only in Custom: picked first)
            {
                if (s.eq != 4) { s.eq = 4; if (real) SetQueue(new byte[] { 0x06, 0x2E, 4 }); }
                s.bands[i - 1] = v; r = new byte[] { 0x06, 0x31, (byte)i, (byte)v }; if (real) SetQueue(r);
            }
            else if (k == "gain" && (v == 1 || v == 2)) { s.gain = v; r = new byte[] { 0x06, 0x27, (byte)v }; if (real) SetQueue(r); }
            else if (k == "mic" && v >= 1 && v <= 10) { s.mic = v; r = new byte[] { 0x06, 0x37, (byte)v }; if (real) SetQueue(r); }
            else if (k == "st" && v >= 0 && v <= 3) { s.st = v; r = new byte[] { 0x06, 0x39, (byte)v }; if (real) SetQueue(r); }
            else if (k == "light" && v >= 1 && v <= 10) { s.light = v; r = new byte[] { 0x06, 0xBF, (byte)v }; if (real) SetQueue(r); }
            else if (k == "off" && v >= 0 && v <= 6) { s.off = v; r = new byte[] { 0x06, 0xC1, (byte)v }; if (real) SetQueue(r); }
            else return;
        }
        Changed();
    }
    // (under setLk) the newest of each setting wins: an older one of the same command (and band) still waiting goes
    static void SetQueue(byte[] r) { setQ.RemoveAll(x => x[1] == r[1] && (r[1] != 0x31 || x[2] == r[2])); setQ.Add(r); }
    // the Headset tab is open: its settings read every 2 s meanwhile (the headset's own button, the base's menu change them too)
    public static void SettingsLook() { setLook = Ms(); }
    static void SetReset() { lock (setLk) { hset = null; setQ.Clear(); setDirty = setOwed = false; } volWant = -1; setLvlMem = -1; setRo = head != null && head.Pid != "12e0"; }   // (only the PC base's firmware was read)
    static void SetFake()
    {
        lock (setLk) hset = new HsSet { nc = 0, tr = 8, eq = 4, gain = 2, mic = 10, st = 0, light = 10, off = 3, bands = new[] { 29, 25, 21, 17, 15, 18, 22, 26, 30, 25 } };
        setLvlMem = 25;
    }
    static Dictionary<string, object> SetCard()
    {
        lock (setLk)
        {
            var s = hset; if (s == null || !HeadThere) return null;
            var d = new Dictionary<string, object>();
            d["nc"] = s.nc; d["tr"] = s.tr; d["eq"] = s.eq; d["bands"] = (int[])s.bands.Clone(); d["gain"] = s.gain; d["mic"] = s.mic; d["st"] = s.st;
            d["light"] = s.light; d["off"] = s.off; d["muted"] = s.muted; d["lvl"] = volWant >= 0 ? volWant : setLvlMem >= 0 ? setLvlMem : knobLevel; d["ro"] = setRo;
            return d;
        }
    }
    // the answers to 06 b0 and 06 20: kept when every value is in the range the firmware takes (another layout: left out)
    static void ReadSettings(byte[] b0, byte[] a)
    {
        if (b0 == null || a == null || b0.Length < 16 || a.Length < 19) return;
        var s = new HsSet { tr = b0[8], muted = b0[9], nc = b0[10], light = b0[11], off = b0[12], gain = a[4], eq = a[6], mic = a[17], st = a[18] };
        bool ok = s.nc <= 2 && s.tr >= 1 && s.tr <= 10 && s.muted <= 1 && s.light >= 1 && s.light <= 10 && s.off <= 6 && (s.gain == 1 || s.gain == 2) && s.eq <= 18 && s.mic >= 1 && s.mic <= 10 && s.st <= 3;
        for (int i = 0; i < 10; i++) { s.bands[i] = a[7 + i]; ok &= s.bands[i] <= 40; }
        bool changed;
        lock (setLk)
        {
            if (setQ.Count > 0 || Ms() - setWrote < 300) return;   // (a change of his still on its way: this answer may be from before it)
            var was = hset; hset = ok ? s : null;
            changed = (was == null) != (hset == null) || (was != null && (was.nc != s.nc || was.tr != s.tr || was.eq != s.eq || was.gain != s.gain || was.mic != s.mic || was.st != s.st || was.light != s.light || was.off != s.off || was.muted != s.muted || string.Join(",", was.bands) != string.Join(",", s.bands)));
            if (!ok && was != null) Log("headset: its settings' answer is not as read in its firmware: the settings are left out");
        }
        if (changed) Changed();
    }
    // in the loop, between the knob's work: the volume wanted, then one queued setting, the read back, the save
    static void SettingsStep(long now, bool knob)
    {
        if (gg || mode == "gg") { lock (setLk) setQ.Clear(); volWant = -1; return; }   // (GG has the base: its own values win, nothing sent)
        if (knob || knobClicks != 0 || basePressed || firstHold) return;   // (the knob first; and the first questions after a connect, as the screen)
        if (volWant >= 0 && knobLevel >= 0)
        {
            int vw = System.Threading.Interlocked.Exchange(ref volWant, -1);   // (taken in one step: a newer one arriving now is never lost)
            if (vw < 0) return;
            if (knobMode) { knobClicks = vw - knobLevel; if (knobClicks != 0) lastSec = -1; }   // (the knob's own way: his page first, the panel locked around 06 25, nothing at the ends)
            else if (vw != knobLevel) { if (head.SetLevel(vw)) { knobLevel = vw; volume = Vol((byte)(0x38 - vw)); lastSec = -1; } else Log("headset: volume " + vw + " not taken"); }   // (the base's own screen: its gauge shows, as on a knob turn)
            return;
        }
        byte[] r = null; bool idle;
        lock (setLk) { if (setQ.Count > 0 && now >= setNext) { r = setQ[0]; setQ.RemoveAt(0); } idle = setQ.Count == 0; }
        if (r != null)
        {
            bool ok = head.Setting(r);
            long t = Ms(); setNext = t + 50; setWrote = t; setReadAt = t + 350; setSaveAt = t + 2000; setDirty = setOwed = true;
            Log("headset: setting " + Hex(r, 1, r.Length) + (ok ? "" : " not taken"));
            return;
        }
        if (!idle || (held && now - wheelAt < 3000) || now - knobAt < 3000 || now < fastUntil) return;   // (not while the knob or the headset's wheel turns: a question there would hold the knob's next step)
        if (setDirty && now >= setSaveAt)
        {
            bool ok = head.Setting(new byte[] { 0x06, 0x09 }); setDirty = false; setOwed = true; setReadAt = Ms() + 300;
            Log("headset: settings kept in the base (06 09)" + (ok ? "" : ", not taken"));
            return;
        }
        if (now >= setReadAt && (setOwed || (now - setLook < 3000 && hset != null)))   // (the tab's own reads once the minute's first questions have answered)
        {
            var b0 = head.Ask(0xB0);
            Thread.Sleep(50);   // (GG's own gap between two questions)
            var a = head.Ask(0x20);
            if (a != null && a[3] <= 0x38 && !knobMode) { if (Vol(a[3]) != volume) { volume = Vol(a[3]); lastSec = -1; } knobLevel = 0x38 - a[3]; }   // (the knob's own mode keeps its level itself)
            ReadSettings(b0, a); setOwed = false; setReadAt = Ms() + 2000;
        }
    }

    // the base's brightness 1 to 10 (06 80's answer [2], or as last set; -1 not known). His slider in Customize sets it
    // with 06 85 when he lets go (11-14, his "why not?" to it). The app sends 06 09 only for the headset's own settings (11-15); the base also saves its settings
    // image (brightness, idle brightness, dim timer, home view, volume) to flash on its own 10 s after a wheel level change
    // (firmware: 0x1224c timer, cb 0xda45, the "app_data" record; hs-knob board wheel-1114, item 7, reviewed 11-14), so a
    // brightness set here persists after his next wheel turn, as the volume does
    public static volatile int Brightness = -1;
    static volatile int brightWant = -1; static bool brightAsked;
    public static void SetBright(int v, bool real)
    {
        if (v < 1 || v > 10) return;
        if (!real) { Brightness = v; return; }
        brightWant = v;
    }

    public static void SetScreen(bool on) { SetScreen(on ? "on" : "dark", true); }   // (Controls' switch in HW Dashboard: off = dark)
    // the Headset tab's Screen (his 11-14 pick): "on" his pages (Custom), "base" the base's own screen and knob (Original),
    // "dark" (Off). save false: a --fake copy's, in memory only
    public static void SetScreen(string m, bool save)
    {
        if (m != "on" && m != "base" && m != "dark") return;
        ScreenOn = m == "on"; ScreenBase = m == "base";
        if (save) try { if (ScreenFile != null) File.WriteAllText(ScreenFile, m); } catch { }
        Log("headset screen: " + (m == "on" ? "custom" : m == "base" ? "original" : "off"));
        lastSec = -1; Changed();
    }

    // his page changed (the Headset screen popup): drawn again now, not at the next second
    public static void Redraw() { lastSec = -1; }

    // the Controls card (x.care's x.ctl.hs): found, switched on, its last line
    public static Dictionary<string, object> Card()
    {
        var d = new Dictionary<string, object>();
        d["there"] = HeadThere; d["mouse"] = MouseOn; d["on"] = ScreenOn; d["base"] = !ScreenOn && ScreenBase; d["off"] = HeadPower == 1; d["chg"] = HeadPower == 2 || HeadPower == 4; d["gg"] = mode == "gg";
        string m = mode;
        d["bright"] = HeadThere ? Brightness : -1;
        d["wheel"] = HeadThere && knobFw && KnobZero;   // (the Headset tab's "Faster volume wheel": only on the base the wheel mode is proven on)
        d["set"] = SetCard();   // (the headset's own settings, null while not known)
        d["cap"] = !HeadThere ? "not found" : m == "gg" ? "SteelSeries GG has it" : m == "dark" ? darkWhy : "headset " + HeadText() + ", " + SpareText();
        return d;
    }

    // every second from the dashboard: its CPU and GPU temperatures (HWiNFO's), and whether a game runs
    static int cpuI = -1, gpuI = -1, feedVer = -1; static Source feedSrc;
    public static void Feed(Source s, bool gaming)
    {
        Gaming = gaming;
        if (s == null || s.Status != "ok") { Cpu = Gpu = double.NaN; return; }
        if (s != feedSrc || s.Version != feedVer) { feedSrc = s; feedVer = s.Version; cpuI = Find(s, "CPU (Tctl/Tdie)"); gpuI = Find(s, "GPU Temperature"); }
        Cpu = cpuI >= 0 && cpuI < s.Values.Length ? s.Values[cpuI] : double.NaN;
        Gpu = gpuI >= 0 && gpuI < s.Values.Length ? s.Values[gpuI] : double.NaN;
    }
    static int Find(Source s, string label)
    {
        for (int i = 0; i < s.Readings.Count; i++) if (s.Readings[i].Orig == label || s.Readings[i].Label == label) return i;
        return -1;
    }

    static int P(int level) { return level < 0 ? -1 : level * 100 / 8; }   // (12, 37, 62, 87: GG's own, cut, not rounded)
    public static double Pct(int level) { return level < 0 ? double.NaN : P(level); }
    public static double HeadValue() { return HeadPower == 1 || HeadPct < 0 ? double.NaN : HeadPct; }   // (off: no value)
    static long estSaved;
    static string EstFile() { return StateFile == null ? null : Path.Combine(Path.GetDirectoryName(StateFile), "headbatt.txt"); }
    static void SaveEst(long now) { estSaved = now; try { string ef = EstFile(); if (ef != null && HeadEst.Step >= 0) File.WriteAllText(ef, HeadEst.State()); } catch { } }
    public static double SpareValue() { return SpareOut ? double.NaN : Pct(SpareLevel); }      // (out: no value)
    static string Level(int l) { return l < 0 ? "--" : P(l) + "%"; }
    static string HeadText() { return HeadPower == 1 ? "off" : (HeadPct < 0 ? "--" : HeadPct + "%") + ((HeadPower == 2 || HeadPower == 4) && HeadPct >= 0 ? " charging" : ""); }
    static string SpareText() { return SpareOut ? "no spare" : "spare " + Level(SpareLevel) + (SpareCharging ? " charging" : ""); }
    static string MouseText() { return MousePct < 0 ? "--" : MousePct + "%" + (MouseCharging == 1 || MouseCharging == 2 ? " charging" : ""); }

    // what the page is drawn from (x-hspage.cs)
    static readonly int[,] Orbit = { { 0, 0 }, { 1, 0 }, { 2, 0 }, { 2, 1 }, { 1, 1 }, { 0, 1 }, { 0, 2 }, { 1, 2 }, { 2, 2 } };   // (1 px a minute; a snake, so a move is one pixel but the last)
    internal static HsInfo Info(DateTime t)
    {
        int k = (int)(t.Ticks / TimeSpan.TicksPerMinute % 9);
        return new HsInfo
        {
            Now = t, Dx = Orbit[k, 0], Dy = Orbit[k, 1], Cpu = Cpu, Gpu = Gpu,
            Head = HeadPct, HeadOff = HeadPower == 1, HeadCharging = HeadPower == 2 || HeadPower == 4,
            Spare = P(SpareLevel), SpareOut = SpareOut, SpareCharging = SpareCharging,
            Mouse = MousePct, MouseCharging = MouseCharging == 1 || MouseCharging == 2, MouseAsleep = MouseAsleep,
            Volume = volume
        };
    }

    // ---- Windows' events: dark at once, not at the loop's next second (sleep and shutdown don't wait) ----
    static void OnSwitch(object s, SessionSwitchEventArgs e)
    {
        if (e.Reason == SessionSwitchReason.SessionLock) { locked = true; ThreadPool.QueueUserWorkItem(_ => GoDark(true)); }   // (off Windows' own thread: its animation takes a second)
        else if (e.Reason == SessionSwitchReason.SessionUnlock) { locked = false; lastSec = -1; }
    }
    static void OnPower(object s, PowerModeChangedEventArgs e)
    {
        if (e.Mode == PowerModes.Suspend) { asleep = true; GoDark(false); }   // (no animation: sleep doesn't wait)
        else if (e.Mode == PowerModes.Resume) { asleep = false; lastSec = -1; }
    }
    static void OnEnding(object s, SessionEndingEventArgs e) { ending = true; endingAt = Environment.TickCount; GoDark(false); }   // (nor Windows shutting down)
    static void GoDark(bool anim)
    {
        if (!ScreenOn && !knobMode && !panelLocked) return;   // (Off / all off keep the knob ours too: freed below, the release review 11-15)
        // (sleep and shutdown wait about 2 s for Windows' handlers: no long wait for the base, the loop's own next look
        // makes it dark if this can't, the review 11-12)
        if (!Monitor.TryEnter(hl, anim ? 5000 : 1500)) return;
        try { if (head != null && (knobMode || panelLocked) && (asleep || ending)) try { Knob(false); } catch { }   // (PC going to sleep or off: the knob is the base's own)
            if (!ScreenOn) return;   // (switched off: the base is dark or its own already; finally lets go of hl)
            if (head != null && !gg) try { if (anim && paged && !asleep && !ending) Play(HsPage.Anim(false), false, HsPage.Draw(Info(DateTime.Now))); Dark(); } catch { } }
        finally { Monitor.Exit(hl); }
    }

    // ---- the headset's loop: the base kept open, asked every minute, its pushes read the moment they come (else every
    // 30 ms); the screen every second, at once when the knob turns ----
    static void HeadLoop()
    {
        headLook = 0; ggLook = -100000;
        while (!stop)
        {
            long now = Ms(); bool knob = false;
            lock (hl)
            {
                if (stop) break;
                try { knob = HeadStep(now); } catch (Exception ex) { LostHead(now, ex.Message); }
            }
            if (!knob && knobClicks == 0 && !basePressed && now - ggLook >= 10000) { ggLook = now; bool g = gg; try { g = GgRuns(); } catch { } if (g != gg) { gg = g; lastSec = -1; } }   // (not on a click: it can take a while)
            if (ending && unchecked(Environment.TickCount - endingAt) > 60000) ending = false;   // (the shutdown was cancelled: carry on)
            int sec = DateTime.Now.Second;
            if (sec != lastSec || knob || (repairAt >= 0 && now >= repairAt) || (now < fastUntil && now - drawnAt >= 250) || (held && wheelOwed && (now - wheelAt >= QuietMs || ProgressDue(now))))   // (the wheel has rested: its number now, not at the next second)
            {
                lastSec = sec;
                lock (hl)
                {
                    if (stop) break;
                    try { Screen(Ms(), knob); } catch (Exception ex) { LostHead(Ms(), ex.Message); }
                }
            }
            var pv = Interlocked.Exchange(ref preview, null);   // (an animation picked in the popup: played here too)
            if (pv != null)
            {
                lock (hl) { if (!stop) try { PlayPreview(pv); } catch (Exception ex) { LostHead(Ms(), ex.Message); } }
            }
            lock (hl) { if (!stop && HoldDue(Ms())) try { Hold(); } catch (Exception ex) { LostHead(Ms(), ex.Message); } }   // (the quiet wheel: right after a picture, or once the base knob has rested)
            if (dumpAt >= 0 && Ms() >= dumpAt) { dumpAt = -1; lock (hl) { if (!stop) DumpTrace(RepairMs + 6500, "after a base event"); } }
            WheelMode();   // (the Headset tab's switch: its values at once, no restart)
            if (refreshWant) { refreshWant = false; lock (hl) { if (!stop && head != null) try { DoRefresh(); } catch (Exception ex) { LostHead(Ms(), ex.Message); } } }   // (his Refresh button)
            // (wait for the base's next push, at most 30 ms. The push collection always has a read waiting after HeadStep;
            // its event is never disposed, so a base lost meanwhile only makes this wait the full 30 ms)
            WaitHandle ev = null, ev2 = null;
            lock (hl) { if (head != null && head.Push != null) { ev = head.Push.ReadEvent; ev2 = head.Cmd.ReadEvent; } }   // (the key test mode's reports come on the command collection; neither event is ever disposed)
            lock (hl) { if (!stop && held && WheelQuiet && head != null) try { PollWheel(Ms()); } catch (Exception ex) { LostHead(Ms(), ex.Message); } }   // (the wheel's level asked every 10 ms while it turns: its clicks known at once, not up to 100 ms later by the push)
            int nap = held && WheelQuiet ? 5 : 30;
            if (ev == null) Thread.Sleep(nap); else WaitHandle.WaitAny(new[] { ev, ev2 }, nap);
        }
    }

    // an animation picked in the Headset screen popup, played on the base as well (his 11-12 "no animations"), when it
    // shows his page: a start up from black to the page, a shut down to black and the page back half a second later
    sealed class Pv { public HsAnim A; public bool Start; }
    static Pv preview;
    public static void Preview(HsAnim a, bool start) { if (a != null) Interlocked.Exchange(ref preview, new Pv { A = a, Start = start }); }
    static void PlayPreview(Pv pv)
    {
        if (head == null || mode != "page" || !paged) return;
        var px = HsPage.Draw(Info(DateTime.Now));
        if (pv.Start) { Send(new bool[128, 64]); Thread.Sleep(250); Play(pv.A, true, px); }
        else { Play(pv.A, false, px); Send(new bool[128, 64]); Thread.Sleep(500); }
        Send(HsPage.Draw(Info(DateTime.Now))); drawnAt = Ms();
    }

    static bool HeadStep(long now)
    {
        if (head == null)
        {
            if (now < headLook) return false;
            headLook = now + 10000;
            head = Arctis.Open();
            if (head == null) return false;
            headAsk = now + (!headSeen ? 300 : knobWasOn ? 1000 : 5000);   // (the base just came back: give it GG's own 5 s first)
            if (!headSeen || knobWasOn) { firstHold = true; firstHoldUntil = now + 2500; }   // (a run that died may have left the panel locked: no picture before the first questions have cleaned up)
            headSeen = true; drew = false; sendFails = 0; HeadThere = true; HeadSeen = true; lastSec = -1;
            knobOk = knobFw = knobAsked = knobClean = knobMode = knobWasOn = knobSoon = panelLocked = basePressed = false; knobWhy = ""; knobLevel = -1; knobClicks = knobTries = 0; busFree = 0; handUntil = 0; sentLeft = sentRight = null;
            held = wheelHit = wheelOwed = false; heldL = heldR = null; holdFails = 0; openTo = 0; wheelAt = turnAt = -100000;
            SetReset();             Brightness = -1; brightAsked = false;   // (asked again: a restarted base is back at its own brightness)
            Log("headset base station found"); Changed();
        }
        head.CollectPushes();
        bool knob = false;
        if (head.Pushes.Count > 0 && now < handUntil) handUntil = now + HandMs;   // (he is busy on the base: its own screens a while longer)
        foreach (var r in head.Pushes)
        {
            if (r.Length < 3 || r[0] != 0x07) continue;
            if (r[1] == 0x25)
            {
                T("push 25 " + r[2].ToString("x2"));
                if (held && r[2] <= 0x38 && 0x38 - r[2] == knobLevel) continue;   // (held: the same level = the echo of our own 06 25 or a late copy of a polled click, the review 11-14)
                bool polled = held && Ms() - levelAskAt < 150;   // (the level is asked every 10 ms: the push, up to 100 ms late, would only put an older level back)
                if (!polled) { volume = Vol(r[2]); if (r[2] <= 0x38) knobLevel = 0x38 - r[2]; }
                if (held)   // (the quiet wheel: the base drew nothing for it; its number once it has rested. While held nothing else moves the volume: the base knob's turns set it unheld, and their echo comes within 100 ms)
                {
                    if (now - wheelAt > 4000) Log("headset screen: the headset's wheel, drawn once it rests");   // (once a go)
                    if (!polled) { wheelAt = now; wheelOwed = true; }
                    if (!polled && now <= openTo) { wheelHit = true; lastSec = -1; }   // (it may have met the open moment: cleaned up at once. Polled: PollWheel knows the click's time to 10 ms and decides)
                    continue;
                }
                fastUntil = now + 4000; knob = true; continue;
            }
            if (r[1] == 0xB7 || r[1] == 0xB5) headAsk = Math.Min(headAsk, now + 300);   // (battery, the headset's link: ask now)
            Log("base pushed " + Hex(r, 2, 10));   // (rare: battery, link, its buttons)
            T("push " + Hex(r, 1, 6)); BaseEvent(now);   // (a base event: its own picture anchored, the page again in a moment, then the trace of it all, 11-17)
        }
        head.Pushes.Clear();
        foreach (var r in head.Inbox)   // the key test mode's reports: 06 b1 81 01 <key> <state>
        {
            if (r.Length < 6 || r[0] != 0x06 || r[1] != 0xB1 || r[2] != 0x81 || r[3] != 0x01) continue;
            if (r[4] == 3) knobClicks++; else if (r[4] == 4) knobClicks--; else if (r[5] != 0) { basePressed = true; pressKey = r[4]; }   // (a click up, a click down, a button going down)
            lastSec = -1;
        }
        head.Inbox.Clear();
        if (!knobMode) { knobClicks = 0; basePressed = false; }   // (reports of a mode that is not ours, left on by a run that died: nothing to apply, and they must not hold the questions back)
        if (brightWant > 0 && held && !knob && knobClicks == 0 && !basePressed && now - wheelAt >= QuietMs) Release();   // (his brightness slider while the wheel is held: a locked panel ignores it, so the hold ends first; held again once it is set)
        if (brightWant > 0 && !knob && knobClicks == 0 && !basePressed && !panelLocked && !held && now >= busFree)
        {
            int bw = System.Threading.Interlocked.Exchange(ref brightWant, -1);   // (taken in one step: a newer value arriving now is never lost)
            if (bw > 0 && head.Bright(bw)) { Brightness = bw; Log("headset base: brightness " + bw + " (his slider)"); } else if (bw > 0) Log("headset base: brightness " + bw + " not taken");
            if (bw > 0) busFree = Math.Max(busFree, Ms() + PassMs);   // (the base may still be setting it on the panel: no lock byte meanwhile, the review 11-14)
        }
        SettingsStep(now, knob);
        if (now < headAsk || knob || knobClicks != 0 || basePressed || (held && now - wheelAt < 3000)) return knob;   // (the minute's questions take 200 ms: not while the knob or the wheel turns)
        headAsk = now + 60000;
        var b0 = head.Ask(0xB0);
        Thread.Sleep(50);   // (GG's own gap between two questions)
        var b7 = head.Ask(0xB7);
        Thread.Sleep(50);
        var b20 = head.Ask(0x20);
        if (b20 != null && b20[3] <= 0x38 && Vol(b20[3]) != volume) { volume = Vol(b20[3]); lastSec = -1; }
        if (b20 != null && b20[3] <= 0x38) knobLevel = 0x38 - b20[3];
        ReadSettings(b0, b20);
        if (b0 != null)   // (its firmware, asked once; then, on the proven one only, its home view every minute: he can change that in the base's menu)
        {
            if (!knobAsked) { Thread.Sleep(50); KnobFirmwareIs(head.Ask(0x10)); }
            byte[] ux = null;
            if (knobFw) { Thread.Sleep(50); ux = head.Ask(0x80); }
            KnobCheck(ux);
            if (ux == null && Brightness < 0 && !brightAsked) { brightAsked = true; Thread.Sleep(50); ux = head.Ask(0x80); }   // (another firmware: its brightness asked once)
            if (ux != null && ux[2] >= 1 && ux[2] <= 10 && brightWant < 0) Brightness = ux[2];
        }
        else if (!knobAsked && !knobSoon) { knobSoon = true; headAsk = now + 5000; }   // (no answer to the first questions: once more in 5 s, not in a minute; the clean up after a run that died waits on them)
        if (b0 == null)
        {
            if (head.Cmd.LastError > 0) throw new IOException("Windows error " + head.Cmd.LastError);   // (unplugged: 1167)
            return knob;
        }
        // its answers, logged when they change: to learn what else moves when the spare comes out or the cable goes in
        string said = "b0 " + Hex(b0, 2, 20) + " | b7 " + Hex(b7, 2, 8) + " | 20 " + Hex(b20, 2, 8);
        if (said != lastSaid) { lastSaid = said; Log("base said " + said); }
        int l = b0[6], s = b0[7], p = b0[15];
        if (l <= 8 && s <= 8)   // (its percent: the step's start counted down by the time the headset is on, see HeadEst; every reading, a minute apart)
        {
            int pc = HeadEst.Feed(l, s, p, now);
            if (pc != HeadPct) { HeadPct = pc; SaveEst(now); if (l == HeadLevel && s == SpareLevel && p == HeadPower) { lastSec = -1; Changed(); } }   // (with a step, spare or power change: said once, below, with the new state)
            else if (now - estSaved > 300000) SaveEst(now);
        }
        if (l <= 8 && s <= 8 && (l != HeadLevel || s != SpareLevel || p != HeadPower))
        {
            HeadLevel = l; SpareLevel = s; HeadPower = p; Changed();
            Log("headset battery " + HeadText() + (p == 1 ? "" : " (step " + l + ")") + ", " + SpareText());   // (a change of step, spare or power only; the base's own step beside the percent)
            lastSec = -1;
        }
        return knob;
    }

    static string Hex(byte[] b, int from, int to)
    {
        if (b == null) return "none";
        var sb = new System.Text.StringBuilder();
        for (int i = from; i < Math.Min(to, b.Length); i++) { if (sb.Length > 0) sb.Append(' '); sb.Append(b[i].ToString("x2")); }
        return sb.ToString();
    }

    // ---- the mouse's loop: the receiver kept open, its pushes read every 100 ms, the battery asked every minute ----
    static void MouseLoop()
    {
        mouseLook = 0;
        while (!stop)
        {
            long now = Ms();
            try { MouseStep(now); } catch (Exception ex) { LostMouse(now, ex.Message); }
            Thread.Sleep(100);
        }
    }

    static void MouseStep(long now)
    {
        if (mouse == null)
        {
            if (now < mouseLook) return;
            mouseLook = now + 10000;
            mouse = Lightspeed.Open();
            if (mouse == null) return;
            mouseAsk = now + 1000; mDev = 0; mIdx = 0; MouseThere = true; MouseSeen = true;
            Log("mouse receiver found"); Changed();
        }
        foreach (var r in mouse.Listen())
        {
            // the receiver: its link to the mouse went down (deep sleep, off) or came up (it woke)
            if (r.Length >= 7 && r[0] == 0x10 && r[2] == 0x41 && r[1] == (mDev == 0 ? 1 : mDev))
            {
                if ((r[4] & 0x40) != 0) { if (!MouseAsleep) { MouseAsleep = true; Changed(); Log("mouse asleep or off"); } }
                else mouseAsk = Math.Min(mouseAsk, now + 1500);
            }
            // its battery, as an event (it sends one as it wakes) or as anyone's getStatus answer (G HUB's too)
            else if (r.Length >= 7 && r[0] == 0x11 && mIdx != 0 && r[1] == mDev && r[2] == mIdx && (r[3] & 0xF0) <= 0x10)
                SetMouse(r[4], r[6]);
        }
        if (now < mouseAsk) return;
        mouseAsk = now + 60000;
        int pct, chg;
        int k = mouse.Status(ref mDev, ref mIdx, out pct, out chg);
        if (k == 1) SetMouse(pct, chg);
        else if (k == 0 && !MouseAsleep) { MouseAsleep = true; Changed(); Log("mouse asleep or off"); }   // (asleep: the last value stays)
    }
    static void SetMouse(int pct, int chg)
    {
        bool ch = pct != MousePct || chg != MouseCharging || MouseAsleep, logIt = pct != MousePct || chg != MouseCharging;
        MousePct = pct; MouseCharging = chg; MouseAsleep = false;
        if (ch) Changed();
        if (logIt)
        {
            Log("mouse battery " + MouseText());   // (a change only)
            try { if (StateFile != null) File.WriteAllText(StateFile, "mouse " + pct + " " + chg); } catch { }
            lastSec = -1;
        }
    }

    static void LostHead(long now, string why)
    {
        Log("headset base station lost: " + why);
        knobWasOn = knobMode || panelLocked;
        if (head != null && knobWasOn) { try { head.NoWait = true; Unlock(); head.KeyTest(false); } catch { } }   // (best effort: gone for real, these fail at once)
        knobMode = panelLocked = held = false; knobClicks = 0; basePressed = false;
        if (head != null) { try { head.Dispose(); } catch { } head = null; }
        headLook = now + 10000; HeadThere = false; drew = false; paged = false; Changed();
    }
    static void LostMouse(long now, string why)
    {
        Log("mouse receiver lost: " + why);
        if (mouse != null) { try { mouse.Dispose(); } catch { } mouse = null; }
        mouseLook = now + 10000; MouseThere = false; Changed();
    }

    static bool GgRuns()
    {
        foreach (var n in new[] { "SteelSeriesGG", "SteelSeriesGGClient", "SteelSeriesEngine" })
        {
            var ps = Process.GetProcessesByName(n); bool any = ps.Length > 0;
            foreach (var p in ps) p.Dispose();
            if (any) return true;
        }
        return false;
    }

    [DllImport("user32.dll")] static extern bool GetLastInputInfo(uint[] info);
    static uint IdleSec() { var li = new uint[] { 8, 0 }; return GetLastInputInfo(li) ? unchecked((uint)Environment.TickCount - li[1]) / 1000 : 0; }

    // ---- the screen ----
    static void Screen(long now, bool click)
    {
        string m, why = "";
        bool repair = repairAt >= 0 && now >= repairAt; if (repair) repairAt = -1;   // (a base event RepairMs ago, 11-17)
        if (basePressed) { basePressed = false; if (knobMode) Log("headset screen: a button on the base (key " + pressKey + "), ignored"); }   // (his 11-14 "BLOCK THESE COMMANDS FULLY": no more 20 s of its own menus)
        if (head == null) m = "none";
        else if (!ScreenOn) { if (headSeen && !gg && !ScreenBase) { m = "dark"; why = "dark, switched off"; } else if (headSeen && !gg && AllOffNow()) { m = "dark"; why = "dark, all off"; } else m = "off"; }   // (Original: the base's own screen and knob; dark for all off only)
        else if (gg) m = "gg";
        else if (now < handUntil && !ending && !asleep && !locked) m = "base";   // (dark wins: PC going off, asleep or locked)
        else if (ending) { m = "dark"; why = "dark, PC shutting down"; }
        else if (asleep) { m = "dark"; why = "dark, PC asleep"; }
        else if (locked) { m = "dark"; why = "dark while locked"; }
        else if (AllOffNow()) { m = "dark"; why = "dark, all off"; }
        else if (DisplaysOff) { m = "dark"; why = "dark, monitors off"; }
        else if (!Gaming && IdleSec() >= AwaySec) { m = "dark"; why = "dark while away"; }
        else m = "page";
        if (m != mode || why != darkWhy)
        {
            if (m != mode || m == "dark") Log("headset screen: " + (why != "" ? why : m));
            mode = m; darkWhy = why; Changed();
        }
        if (head == null) return;
        if (firstHold) { if (knobAsked || now >= firstHoldUntil) firstHold = false; else { lastSec = -1; if (repair) repairAt = now + RepairMs; return; } }   // (the first questions clean up after a run that died: no picture into a panel that may still be locked)
        bool wantKnob = knobOk && (m == "page" || (m == "dark" && !ending && !asleep));   // (PC off or asleep: the knob is the base's own)
        if (wantKnob != knobMode) Knob(wantKnob);
        if (m == "off" || m == "gg" || m == "base") { if (drew) { if (m == "off" && paged) Play(HsPage.Anim(false), false, HsPage.Draw(Info(DateTime.Now))); head.ScreenBack(); drew = false; Bus(PassMs); sentLeft = sentRight = null; } paged = false; return; }   // (Power off: his shut down animation first)
        if (click)   // (a knob click: the base's own volume screen is up, and drops every picture until 06 95)
        {
            if (now - knobAt > 4000) Log("headset screen: volume knob, taken back from the base's volume screen");   // (once a turn)
            knobAt = now; head.ScreenBack(); Bus(PassMs); sentLeft = sentRight = null;
            if (m == "dark") { Dark(); return; }
        }
        if (knobMode && knobClicks != 0 && (m == "dark" ? lastDark : paged) && KnobTurn(now, m == "dark")) return;   // (the knob, reported by the key test mode: the volume is ours to set; at the top or the bottom nothing was sent and the pass goes on)
        if (repair)   // (whatever the panel shows, the page again: nothing counts as shown, and the next open moment sets the panel's window anew)
        {
            T("repair: the page again" + (held ? " (held)" : "") + (m == "dark" ? " (dark)" : ""));
            heldL = heldR = null; sentLeft = sentRight = null; anchorAt = -100000; lastDark = false;
        }
        bool owed = false;
        if (held)   // (the quiet wheel: nothing is drawn while it turns)
        {
            if (wheelHit) { wheelHit = false; CleanUp(); }
            if (now - wheelAt < QuietMs && !ProgressDue(now)) return;
            owed = wheelOwed || heldL == null; wheelOwed = false;
        }
        if (held && !owed && m != "dark" && HeldEveryMs > 1000 && now - heldAt < HeldEveryMs) return;   // (held, his page's own changes at most every HeldEveryMs: each one opens the panel for a moment a wheel click can meet; the wheel's number never waits)
        if (m == "dark") { if (!lastDark || now - darkAt >= 5000 || (held && !Shows(Packets(new bool[128, 64])))) { if (paged && !asleep && !ending) Play(HsPage.Anim(false), false, HsPage.Draw(Info(DateTime.Now))); Dark(); if (knobMode && knobClicks != 0) lastSec = -1; } return; }   // (again every 5 s, in case the base took it back; his shut down animation first, away or locked)
        var px = HsPage.Draw(Info(DateTime.Now));
        if (!paged && !click) Play(HsPage.Anim(true), true, px);   // (the page comes back: the dashboard started, unlocked, woke, he is back; his start up animation first)
        Send(px); lastDark = false; drawnAt = Ms(); paged = true;
        if (knobMode && knobClicks != 0) lastSec = -1;   // (clicks that came before the page was up: next look)
    }

    // ---- after a base event: the page again, and what was sent (11-17, hwdeck\local\hs-battery-1117\findings.md) ----
    // His 11-17 22:3x, twice: "the ui glitched on the deck" = his page pushed about a quarter of the screen sideways,
    // not evenly, from the picture sent right after the base's spare slot read empty until the next change of the
    // page (22 s, then 6 s: his page has no clock, so between changes nothing is sent and a picture that comes out
    // wrong stays). The app saw nothing: every report was taken. The cause is not proven (the base's firmware puts a
    // picture together in one go; the panel's write position or window left wrong fits, as after a wheel hit). So:
    // RepairMs after any push of the base that is not the wheel's, the page goes out again through the open moment
    // with the panel's window set anew (the re-anchor), whatever it shows; and what was sent in the seconds around it
    // is written to the log, there and on his Refresh button, so the next one is read, not guessed.
    const int RepairMs = 1500;
    static long repairAt = -1, repairFrom, dumpAt = -1, eventAt = -100000;   // (eventAt: the last push that was not the wheel's; repairFrom: the first push of the burst the repair waits out)
    static readonly string[] trText = new string[256]; static readonly long[] trAt = new long[256]; static int trN;
    static void T(string s) { int k = trN & 255; trText[k] = s; trAt[k] = Ms(); trN = (trN + 1) & int.MaxValue; }
    // a push of the base that is not the wheel's: the page again RepairMs after the last one of a burst (pushes come in
    // twos and threes), 4 s after the first at the latest (a contact that chatters must not hold it back for good)
    static void BaseEvent(long now)
    {
        if (repairAt < 0) repairFrom = now;
        eventAt = now; repairAt = Math.Min(now + RepairMs, repairFrom + 4000); dumpAt = repairAt + 2500;
    }
    static void DumpTrace(int lastMs, string why)
    {
        long now = Ms(); var t0 = DateTime.Now; int n = Math.Min(trN, trText.Length), shown = 0;
        var sb = new System.Text.StringBuilder();
        for (int i = trN - n; i < trN; i++)
        {
            int k = i & 255; if (now - trAt[k] > lastMs) continue;
            sb.Append(shown++ == 0 ? "" : " | ").Append(t0.AddMilliseconds(trAt[k] - now).ToString("ss.fff", System.Globalization.CultureInfo.InvariantCulture)).Append(' ').Append(trText[k]);
        }
        Log("headset screen: sent in the last " + (lastMs / 1000) + " s (" + why + "): " + (shown == 0 ? "nothing" : sb.ToString()));
    }

    static void Dark() { Send(new bool[128, 64]); lastDark = true; darkAt = Ms(); paged = false; }

    // ---- the volume knob with none of the base's own screens (see volume above) ----
    // the base's answer to 06 10, asked once per connect: its firmware, as text from byte 2
    // ("0000.003.0820001.029.027" then the headset's own version). No answer: asked again with the next minute's
    // questions, three times in all, then it counts as not the proven one (one missed answer must not leave a run
    // that died uncleaned)
    static void KnobFirmwareIs(byte[] fw)
    {
        var sb = new System.Text.StringBuilder();
        if (fw != null) for (int i = 2; i < 34 && i < fw.Length; i++) sb.Append(fw[i] >= 0x20 && fw[i] < 0x7f ? (char)fw[i] : '.');
        string s = sb.ToString();
        knobAsked = fw != null || ++knobTries >= 3; knobFw = s.Length >= 24 && s.Substring(12, 12) == KnobFirmware && head != null && head.Pid == "12e0";   // (the PC base station only: the Xbox ones are found too since 11-15, their firmware never proven)
        Log("headset base: firmware " + (fw == null ? "not answered" : s.TrimEnd('.')) + (knobFw || !knobAsked ? "" : " (the volume knob stays the old way: not the firmware it was proven on)"));
    }
    // an error nobody caught is ending the app: the knob is the base's own again and the panel unlocked, best effort
    // (a kill or a power cut can't be caught: the next run's first questions clean up)
    static void OnCrash(object s, UnhandledExceptionEventArgs e)
    {
        if (!e.IsTerminating || !Monitor.TryEnter(hl, 300)) return;
        try { if (head != null && (knobMode || panelLocked)) { head.NoWait = true; Unlock(); head.KeyTest(false); knobMode = false; } }
        catch { }
        finally { Monitor.Exit(hl); }
    }
    // every minute: on the proven firmware, clean up once what a run that died left behind (whatever the switch says),
    // then the base's screen settings (06 80: [5] = 0 is the detailed home view): the knob is ours only in that view
    static void KnobCheck(byte[] ux)
    {
        if (knobFw && !knobClean && !knobMode) { Unlock(); knobClean = head.KeyTest(false); }   // (refused: again next minute)
        if (knobFw && ux == null && knobOk) return;   // (one answer missed: as it was, the next minute asks again)
        bool view = ux != null && ux[5] == 0, ok = KnobZero && knobFw && view;
        string why = !knobFw ? "firmware" : !KnobZero ? "switched off" : ux == null ? "no answer" : !view ? "the base's home view is not the detailed one" : "";
        if (ok != knobOk || why != knobWhy) { knobOk = ok; knobWhy = why; lastSec = -1; if (knobFw) Log("headset base: the volume knob without its own screens: " + (ok ? "yes" : "no, " + why)); }
    }

    // the key test mode on or off; off also unlocks the panel
    static void Knob(bool on)
    {
        if (on)
        {
            var ux = head.Ask(0x80);   // (the home view again: only the detailed one's gauge stays in the right half)
            var v = ux != null && ux[5] == 0 ? head.Ask(0x20) : null;   // (and the volume as it is now: he may have turned it on the base or on the headset meanwhile)
            if (v == null || v[3] > 0x38)
            {
                knobOk = false; knobWhy = ux == null ? "no answer" : ux[5] != 0 ? "the base's home view is not the detailed one" : "no volume";   // (the minute's check tries again)
                if (ux == null || v == null) headAsk = Math.Min(headAsk, Ms() + 5000);   // (a missed answer, common right after a start: asked again in 5 s, not a minute of the old knob, 11-14)
                Log("headset base: the volume knob without its own screens: no, " + knobWhy); return;
            }
            knobLevel = 0x38 - v[3]; volume = Vol(v[3]);
            Unlock();
            if (!head.KeyTest(true)) { head.KeyTest(false); knobClean = false; Log("headset base: the key test mode was not taken"); knobOk = false; knobWhy = "not taken"; return; }   // (it may have landed all the same: off now, and again with the minute's check)
            knobMode = true; knobClicks = 0;
            Log("headset base: the volume knob is ours (key test mode on, volume " + volume + "%)");
        }
        else
        {
            try { Release(); } catch { }   // (a refused picture must not keep the knob dead or the panel locked: the unlock and the off still go)
            Unlock();
            bool off = head.KeyTest(false);
            if (!off) { Thread.Sleep(8); off = head.KeyTest(false); }   // (once more: a lost off is a dead knob)
            knobClean = off;   // (refused twice: the minute's check sends it again)
            if (knobMode) Log("headset base: the volume knob is its own again (key test mode off" + (off ? ")" : ", NOT taken: again within a minute)"));
            knobMode = false; knobClicks = 0;
        }
    }

    // the knob turned: the volume set here, the panel locked around it so the base's gauge never reaches it. False at
    // the top or the bottom of the range: nothing was sent (every 06 25 also goes to the headset, which beeps at its limit)
    static bool KnobTurn(long now, bool dark)
    {
        int nl = Math.Max(0, Math.Min(0x38, knobLevel + knobClicks)); knobClicks = 0;
        if (nl == knobLevel) return false;
        if (now - knobAt > 4000) Log("headset screen: volume knob, set here with the panel locked");   // (once a turn)
        knobAt = now; knobLevel = nl; volume = Vol((byte)(0x38 - nl));
        var px = dark ? new bool[128, 64] : HsPage.Draw(Info(DateTime.Now));
        if (held) Open(Packets(px), false);   // (the quiet wheel's hold: this click's page through the open moment; the rest of the turn as below, held again once the knob has rested)
        if (!dark) { WaitBus(); SendHalves(px, false); }   // (the page answers the knob first, ALWAYS, also while he keeps turning: the number shows 40 to 80 ms after a click, the sound follows; his 11-13 "small input delay", then 17:33 "the knob still has a delay to when it updates i think", and the test with the page first every time 17:43: "base knob was fine")
        WaitBus();
        panelLocked = head.PanelLock(true);
        bool set = false;
        try { set = head.SetLevel(nl); busFree = Ms() + GaugeMs; }
        finally { Unlock(); }
        bool more = false;   // (more clicks came meanwhile: he keeps turning)
        head.CollectPushes();
        foreach (var r in head.Inbox) if (r.Length >= 6 && r[0] == 0x06 && r[1] == 0xB1 && r[2] == 0x81 && r[3] == 0x01 && (r[4] == 3 || r[4] == 4)) { more = true; break; }
        if (more && !dark) sentRight = null;   // (the next click's page sends the right half first, so the gauge's columns in the base's copy are ours again before anything else is flushed: one picture less per step while he turns, about 40 ms, 11-14 "for knob as well". The last step of a turn still sends it at once)
        else SendHalves(px, true);   // (the right half always: the gauge's columns in the base's copy are ours again, and the panel gets a fresh window)
        drawnAt = turnAt = Ms();
        if (!set) { var v = head.Ask(0x20); if (v != null && v[3] <= 0x38) { knobLevel = 0x38 - v[3]; volume = Vol(v[3]); lastSec = -1; } }   // (the volume was not taken: what the base really has)
        return true;
    }

    // unlocked three times, 8 ms apart, once the base's display is free: a pair that lands while it is busy is dropped
    // with no sign, and a later pair cures a half one. A frozen panel is the worse miss
    static void Unlock()
    {
        NapUntil(busFree + 8);   // (the timing GaugeMs was proven with: Thread.Sleep then came back about 8 ms late on average and slept 8 as about 16; kept so, the review 11-14)
        for (int i = 0; i < 3; i++) { if (i > 0) NapUntil(Ms() + 16); head.PanelLock(false); }
        panelLocked = held = wheelHit = false;
    }
    // (to the millisecond: Thread.Sleep could add up to 15 ms to every wait of the knob's steps, 11-14)
    static void WaitBus() { NapUntil(busFree); }
    // the base's display is busy for ms more: a picture that lands during a pass makes it run one more, never more than that
    static void Bus(int ms) { long n = Ms(); busFree = Math.Min(Math.Max(busFree, n) + ms, n + 2 * ms); }

    // a picture as its two halves, the right one first; a half the base already has is skipped (the right one never when forced)
    static void SendHalves(bool[,] px, bool forceRight)
    {
        var reps = Packets(px);
        for (int i = 1; i >= 0; i--)
        {
            if (!(i == 1 && forceRight) && Same(i == 1 ? sentRight : sentLeft, reps[i])) continue;
            bool ok = head.Feature(reps[i]); Bus(PassMs);
            if (i == 1) sentRight = ok ? reps[i] : null; else sentLeft = ok ? reps[i] : null;
            drew = true;
            if (ok) sendFails = 0;
            else if (++sendFails >= 3) throw new IOException("the screen refused 3 pictures in a row");
        }
    }
    static bool Same(byte[] a, byte[] b)
    {
        if (a == null || b == null || a.Length != b.Length) return false;
        for (int i = 0; i < a.Length; i++) if (a[i] != b[i]) return false;
        return true;
    }

    // a start up or shut down animation he picked (x-hsdraw.cs; null: none), as fast as the base takes pictures, at most
    // 30 a second, all within its own length (0.3 to 1.5 s). The base's top rate, measured 11-13: a full picture takes
    // 36 ms (two halves of 18 ms, the same while the knob turns), so about 27 a second
    static void Play(HsAnim a, bool start, bool[,] page)
    {
        if (a == null) return;
        int len = start ? a.StartMs : a.StopMs, n = 0; var sw = Stopwatch.StartNew();
        while (true)
        {
            long t = sw.ElapsedMilliseconds; if (t >= len || (start && stop) || asleep || ending) break;   // (the PC is going: the lock is free for GoDark, which has 1.5 s to switch the knob's mode off)
            Send(start ? a.Start(t, page) : a.Stop(t, page)); n++;
            long rest = 33 - (sw.ElapsedMilliseconds - t); if (rest > 0) Thread.Sleep((int)rest);
        }
        Log("headset screen: " + (start ? "start up " : "shut down ") + a.Name + ", " + n + " pictures in " + sw.ElapsedMilliseconds + " ms");
    }

    static void Send(bool[,] px)
    {
        if (held) { Show(px); return; }
        bool ok = true;
        var reps = Packets(px);
        bool rightFirst = sentRight == null;   // (the base's copy may still hold the gauge's columns, a knob step that left its right half to the next picture: the right half first, so no flush ever shows them, the review 11-14)
        for (int k = 0; k < 2; k++) { int i = rightFirst ? 1 - k : k; bool one = head.Feature(reps[i]); ok &= one; Bus(PassMs); if (i == 0) sentLeft = one ? reps[i] : null; else sentRight = one ? reps[i] : null; }
        drew = true;
        T("send (not held): both halves" + (ok ? "" : ", one REFUSED"));
        if (ok) sendFails = 0;
        else if (++sendFails >= 3) throw new IOException("the screen refused 3 pictures in a row");
    }

    // ---- the quiet wheel (see volume above): held = the panel locked and the screen the base's ----
    // the wheel mode, from the Headset tab's "Faster volume wheel" (saved with the headset's setup): off = the number
    // 200 ms after he rests (his 11-14 pick A, the default), on = 30 ms and the lock 34 ms after a half (B, experimental:
    // snappier, the base's own volume screen flashes more often). Always held where the knob mode works: his 11-14
    // "Base's own screen SHOULD NOT BE an option". hs-wheel.txt is no longer read
    static void WheelMode()
    {
        bool fast = HsPage.WheelFast;
        if (wheelSet && fast == wheelFastNow) return;
        wheelSet = true; wheelFastNow = fast;
        WheelQuiet = true; HeldEveryMs = 1000; QuietMs = fast ? 30 : 200; HeldPassMs = fast ? 34 : 40; ProgressMs = 0;
        Log("headset screen: the wheel mode " + (fast ? "faster (experimental)" : "standard") + ", number after " + QuietMs + " ms of rest, lock " + HeldPassMs + " ms after a half");
    }

    // the Headset tab's Refresh (his 11-14 "add a refresh button to unbug in case it happens"): the screen set up again
    // with the commands the knob and the wheel send anyway (no new bytes): the base's own screens' time ended, the hold
    // ended (our last picture through the open moment), the panel unlocked, the key test mode off and on again; then the
    // base's gauge at the same level on the locked panel, unlocked, and the whole picture at the next look (the knob's
    // own step: the right half after the gauge makes the base send its window command, so a shifted write pointer is
    // set again). Not at 0 or 56 (the headset beeps at its limit): the picture alone then
    static volatile bool refreshWant; static int pressKey;
    public static void Refresh() { refreshWant = true; }
    static void DoRefresh()
    {
        Log("headset screen: refresh (his button)");
        DumpTrace(60000, "his Refresh button");
        handUntil = 0; basePressed = false; knobClicks = 0; wheelHit = wheelOwed = false;
        if (knobMode || held || panelLocked) Knob(false);
        else if (knobFw) { Unlock(); head.KeyTest(false); }   // (the connect's own clean up: a panel left locked by a dropped unlock is free again, the review 11-14)
        sentLeft = sentRight = null; heldL = heldR = null; lastDark = false;   // (drew kept: a switch off in the same pass still hands the screen back, the review 11-14)
        if (mode == "off" && !gg) { head.ScreenBack(); drew = false; paged = false; busFree = Ms() + HomeMs; }   // (Original: the screen the base's own again, in case it was left holding a picture)
        if (knobOk && !gg && (mode == "page" || (mode == "dark" && !ending && !asleep)))   // (as Screen's own: PC going off or asleep, the knob stays the base's)
        {
            NapUntil(Ms() + HomeMs);   // (off and on not back to back: the base's own draw after the key test mode's off is over first, the review 11-14)
            Knob(true);
            if (knobMode && knobLevel > 0 && knobLevel < 0x38)
            {
                WaitBus(); panelLocked = head.PanelLock(true);
                try { head.SetLevel(knobLevel); busFree = Ms() + GaugeMs; } finally { Unlock(); }
            }
            if (knobMode)   // (HEAL on his Refresh, 11-15, hs-knob's review: once the knob is ours, the panel locked and the screen the base's (a touch draws nothing), its home pass over)
            {
                WaitBus();
                if (knobLevel >= 0) { var v0 = head.Ask(0x20, 40); if (v0 != null && v0[3] <= 0x38 && 0x38 - v0[3] != knobLevel) { knobLevel = 0x38 - v0[3]; volume = Vol(v0[3]); wheelAt = Ms(); wheelOwed = true; NapUntil(Ms() + HomeMs); } }   // (Hold's guard before the lock: a wheel click right then, its draw over first, hs-knob 11-15)
                head.PanelLock(true); head.ScreenBack(); NapUntil(Ms() + HomeMs);
                bool hok = head.Heal(true); busFree = Ms() + 10; sentLeft = sentRight = null; heldL = heldR = null; panelLocked = held = true;
                Log("headset screen: the panel's set up sent again (refresh): " + (hok ? "ok" : "not all taken"));
            }
        }
        headAsk = Math.Min(headAsk, Ms() + 300); lastSec = -1;   // (the minute's questions soon: the base's home view again; the picture at the next look, both halves)
    }

    // the wheel's level, asked: every 10 ms while it is in use (3 s from its last click), every 40 ms otherwise. A change
    // = a click now (the push comes up to 100 ms later, from the base's timer); one within the open moment = maybe a hit.
    // His clicks come in bursts (2 or 3, 16 to 50 ms apart) with 150 to 300 ms between them (131 timed clicks, 11-14): the
    // number goes out QuietMs after a burst and is on the panel before the next one
    static long levelAskAt, lockedAt = -100000, anchorAt = -100000, tryAt = -100000;
    // HEAL, automatic (his 11-15 yes): the panel's set up replayed while held (a wheel click draws nothing), once the base's
    // own home pass is over; after a flash only (a hit cleaned up, a click that met the open moment), never after a picture.
    // A wheel click during it (06 20 says): sent once more after the base's draw
    static void HealPanel(string why)
    {
        if (head == null || !held) return;
        NapUntil(busFree);
        bool ok = head.Heal(true); busFree = Ms() + 10;
        if (knobLevel >= 0) { var v = head.Ask(0x20, 40); if (v != null && v[3] <= 0x38 && 0x38 - v[3] != knobLevel) { knobLevel = 0x38 - v[3]; volume = Vol(v[3]); wheelAt = Ms(); wheelOwed = true; NapUntil(Ms() + HomeMs); ok &= head.Heal(true); busFree = Ms() + 10; why += ", again after a wheel click"; } }
        Log("headset screen: the panel's set up sent again (" + why + "): " + (ok ? "ok" : "not all taken"));
    }
    static int ProgressMs;   // held: while he keeps turning, the number also goes out this often (0: only once he rests QuietMs), right after one of his bursts (30 ms quiet); his 11-14 "if i keep giving inputs nonstop it stays the old value until i pause"
    static bool ProgressDue(long now) { return ProgressMs > 0 && wheelOwed && now - wheelAt >= 30 && now - tryAt >= ProgressMs; } static bool hitCheck;   // (hitCheck: the first answered poll after a lock decides whether a click met the open moment)
    static void PollWheel(long now)
    {
        if (now - levelAskAt < (now - wheelAt < 3000 ? 10 : 50)) return;
        levelAskAt = now;
        var v = head.Ask(0x20, 40);
        if (v == null || v[3] > 0x38) return;
        bool check = hitCheck; hitCheck = false;
        int lv = 0x38 - v[3];
        if (lv == knobLevel) return;
        if (now - wheelAt > 4000) Log("headset screen: the headset's wheel, drawn after each burst");   // (once a go)
        knobLevel = lv; volume = Vol(v[3]); wheelAt = Ms(); wheelOwed = true;
        if (check) { wheelHit = true; lastSec = -1; }   // (the first answer after the lock: the click may have come before it, while the panel was open)
    }

    static bool HoldDue(long now) { return head != null && WheelQuiet && knobMode && !held && drew && !firstHold && brightWant <= 0 && (mode == "page" || mode == "dark") && now - turnAt >= Math.Max(QuietMs, 300); }   // (the base knob's rest stays 300 ms: the wheel's short quiet would hold between its detents, the review 11-14)   // (not while his brightness waits: it can't reach a locked panel)

    // held: a picture the panel doesn't show yet goes through the open moment
    static void Show(bool[,] px)
    {
        var reps = Packets(px);
        if (Shows(reps)) return;   // (the panel shows it already: no open moment)
        Open(reps, true);
    }
    static bool Shows(List<byte[]> reps) { return heldL != null && heldR != null && Ms() - heldAt < (Ms() - wheelAt < 10000 || knobLevel <= 0 || knobLevel >= 0x38 ? 5000 : 60000) && Same(heldL, reps[0]) && Same(heldR, reps[1]); }   // (at most 5 s old: a wheel click at 0 or 100 % changes no level and sends no push, so a hit then is unseen; and an unlock dropped in a long pass leaves the old picture; the review 11-14)

    // held: a picture through the open moment. Its left half while the panel is still locked (it only goes into the
    // base's copy; the screen is the host's from here), then, unless a wheel click came meanwhile (mayStop), the panel
    // unlocked and the right half: the base sends the panel its whole copy, the whole new picture. Hold() ends the
    // moment. False: nothing changed on the panel, still held
    static bool Open(List<byte[]> reps, bool mayStop)
    {
        NapUntil(busFree);
        if (mayStop) tryAt = Ms();
        long tOpen = Ms();
        bool okL = head.Feature(reps[0]);
        // RE-ANCHOR (11-14, board wheel-1114 065038 / 065700): the 06 25 gauge right behind the left half (a partial window,
        // to the locked panel: the base's window cache becomes partial), so the right half below, on the UNLOCKED panel, makes
        // the base send its own window command (22 00 07 21 00 7f, one transfer) = the panel's write pointer reset at the start
        // of every picture. A lock pair split at a pass edge (a lone 12 / 16 moves that pointer, kept for ever by the skipped
        // window command: the 06:04 break) is undone by the next picture. The level asked right before (a click in between
        // would be undone); never at 0 or 56 (the headset beeps at its limit)
        bool anchored = false, early = false;
        if (okL && mayStop && knobLevel > 0 && knobLevel < 0x38 && (Ms() - wheelAt < 30000 || Ms() - eventAt < 5000 || Ms() - anchorAt >= 60000))   // (up to 30 s after the wheel's last use, 5 s after a base event (11-17), else every 60 s: each 06 25 also goes to the headset and re-applies the volume)
        {
            var v0 = head.Ask(0x20, 40);
            if (v0 != null && v0[3] <= 0x38)
            {
                int lv0 = 0x38 - v0[3];
                if (lv0 != knobLevel) { early = true; knobLevel = lv0; volume = Vol(v0[3]); }
                else if (lv0 > 0 && lv0 < 0x38) { anchored = head.SetLevel(lv0); if (anchored) anchorAt = Ms(); }
            }
        }
        Bus(anchored ? HeldPassMs + 12 : HeldPassMs);   // (its pass goes to the locked panel, the gauge's chained behind it; the unlock must not land inside them)
        NapUntil(busFree);
        bool click = early || (mayStop && WheelWaits());
        if (!click && mayStop && okL && knobLevel >= 0)   // (the base sends its push up to 100 ms after a click, its level changes at once: asked, so a click in the locked part is caught before the panel opens, 11-14)
        {
            var v = head.Ask(0x20);
            if (v != null && v[3] <= 0x38 && 0x38 - v[3] != knobLevel) { click = true; knobLevel = 0x38 - v[3]; volume = Vol(v[3]); Log("headset screen: a wheel click came just before a picture: stopped before the panel opened"); }   // (the level kept: the next picture is not stopped by the same change)
            click |= WheelWaits();   // (a push that came while it was asked; at 0 or 100 % only the push shows a click)
        }
        if (!okL || click)
        {
            T("open: " + (!okL ? "left half REFUSED" : "a wheel click before the panel opened") + ", stopped");
            if (click) { wheelAt = Ms(); wheelOwed = true; NapUntil(Ms() + HomeMs); }   // (it may have taken the screen back behind the lock: its draw is over first)
            head.ScreenBack(); busFree = Ms() + HomeMs; sentLeft = sentRight = null;   // (a refused half still made the screen the host's: the base's again)
            if (!okL && ++sendFails >= 3) throw new IOException("the screen refused 3 pictures in a row");
            return false;
        }
        long tUn = Ms(); bool unl = head.PanelLock(false); panelLocked = held = wheelHit = false;
        bool okR = head.Feature(reps[1]); Bus(HeldPassMs);
        T("open: left" + (anchored ? ", anchor" : "") + ", unlock " + (unl ? "" : "REFUSED ") + "at +" + (tUn - tOpen) + " ms, right " + (okR ? "" : "REFUSED ") + "done +" + (Ms() - tOpen) + " ms");   // (the open moment: locked again once this pass is surely over)
        sentLeft = reps[0]; sentRight = okR ? reps[1] : null; drew = true; heldAt = Ms();
        if (okR) sendFails = 0; else if (++sendFails >= 3) throw new IOException("the screen refused 3 pictures in a row");
        return true;
    }

    // the open moment ends: the panel locked again ONLY once the base's display is surely free (two pairs, 8 ms apart, as
    // Unlock and the knob do); then 06 95 00: the screen is the base's again (a wheel click draws nothing) and its home
    // frame goes to the locked panel and into its copy. Until 11-14 the first tries went out about 18 ms after the last
    // half, while the base was still sending the panel its rows: a lock is two reports (fd, then 16), and when the fd
    // lands in a gap between rows and the 16 is dropped, the panel's chip takes the base's next command as the fd's
    // value and reads the rest as commands of their own. Most likely why the held wheel left the panel scrambled until a
    // replug (11-13 21:0x); knobtest9 (always waited) and the knob path (WaitBus) never did
    static void Hold()
    {
        NapUntil(busFree);
        // a click in the open moment: the base is drawing its own frame now (about 90 ms, which busFree doesn't know),
        // so the lock waits until that draw is over (the review 11-14), and the panel counts as showing the base's frame
        // (the question before the lock is NEEDED: 11-14 06:04 the snappier wheel left it out and scrambled the panel
        // within a minute (a replug cured it). A take back is ONE full pass (board 065038 / 065630), but a lock pair whose fd
        // is dropped by a running pass and whose 16 lands after it leaves a lone 16 on the unlocked chip (the pointer moves);
        // the click that starts such a pass changes the level first, so this question sees it)
        bool click = WheelWaits();
        if (!click && knobLevel >= 0)
        {
            var v = head.Ask(0x20, 40);
            if (v != null && v[3] <= 0x38 && 0x38 - v[3] != knobLevel) { click = true; knobLevel = 0x38 - v[3]; volume = Vol(v[3]); }
            click |= WheelWaits();
        }
        if (click) { NapUntil(Ms() + HomeMs); wheelAt = Ms(); wheelOwed = true; Log("headset screen: a wheel click met a picture: locked once the base's own draw was over, drawn again once it rests"); }
        bool any = head.PanelLock(true);
        NapUntil(Ms() + 24);   // (the second pair 24 ms later: a take back started in the first pair's gap is over by then, and this one resolves a pending fd now, board 065700 C3)
        if (knobLevel >= 0) { var v2 = head.Ask(0x20, 40); if (v2 != null && v2[3] <= 0x38 && 0x38 - v2[3] != knobLevel) { knobLevel = 0x38 - v2[3]; volume = Vol(v2[3]); wheelAt = Ms(); wheelOwed = true; click = true; NapUntil(Ms() + HomeMs); } }   // (asked again before pair 2, board 070414 C2: a click since pair 1 = its take back's pass may run, so pair 2 waits it out; the panel then counts as maybe showing the base's frame)
        any |= head.PanelLock(true);
        if (!any) { if (++holdFails >= 3) throw new IOException("the panel lock was refused 3 times"); return; }
        holdFails = 0; panelLocked = held = true; heldL = click ? null : sentLeft; heldR = click ? null : sentRight;
        lockedAt = Ms(); hitCheck = true;
        head.ScreenBack();
        T("hold: locked" + (click ? " after a wheel click" : "") + ", screen handed back");
        openTo = Ms() + 110;   // (a click in the open moment is pushed up to 100 ms later)
        busFree = Ms() + HomeMs; sentLeft = sentRight = null;
        if (click) HealPanel("a wheel click met a picture");
    }

    // a wheel click may have met the open moment: the base took the screen (its frame may be on the panel, and the lock
    // may have been dropped during its draw). Locked again and handed back; drawn again once the wheel has rested HitQuietMs
    static void CleanUp()
    {
        NapUntil(Ms() + HomeMs);   // (its draw is over: a take back is ONE full pass, chained at most behind ours, board 065038 / 065630 R7; HomeMs kept as the margin)
        NapUntil(busFree);
        for (int i = 0; i < 2; i++) { if (i > 0) NapUntil(Ms() + 24); head.PanelLock(true); }   // (two pairs 24 ms apart: fewer pairs near a pass edge, 11-14)
        head.ScreenBack(); busFree = Ms() + HomeMs; sentLeft = sentRight = null; heldL = heldR = null; panelLocked = held = true;
        Log("headset screen: a wheel click may have met a picture: locked again, drawn again once it rests");
        T("clean up after a hit");
        HealPanel("after a hit");
    }

    // the hold ends (the knob mode goes off): the last picture again through the open moment, so the screen is the host's
    // with our picture on the panel, as before the hold (neither the base's frame nor half of it shows)
    static void Release()
    {
        if (!held) return;
        Open(heldL != null && heldR != null ? new List<byte[]> { heldL, heldR } : Packets(new bool[128, 64]), false);
    }

    // a volume push not looked at yet (the list holds only those: the loop empties it each pass), also one the minute's
    // questions picked up: held, that is the headset's wheel turning
    static bool WheelWaits()
    {
        head.CollectPushes();
        foreach (var r in head.Pushes) if (r.Length >= 3 && r[0] == 0x07 && r[1] == 0x25 && r[2] <= 0x38 && 0x38 - r[2] != knobLevel) return true;   // (a new level only: the base's echo of our own 06 25 carries the same one, the review 11-14)
        return false;
    }

    // a wait to the millisecond (the open moment's timing): a high resolution waitable timer (Windows 10 1803 on), else
    // Thread.Sleep, which may sleep 15 ms
    [DllImport("kernel32.dll")] static extern IntPtr CreateWaitableTimerExW(IntPtr attr, IntPtr name, uint flags, uint access);
    [DllImport("kernel32.dll")] static extern bool SetWaitableTimer(IntPtr timer, ref long due, int period, IntPtr routine, IntPtr arg, bool resume);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint ms);
    static IntPtr napTimer; static bool napTried;
    static void NapUntil(long t)
    {
        while (true)
        {
            long w = t - Ms(); if (w <= 0) return;
            if (!napTried) { napTried = true; napTimer = CreateWaitableTimerExW(IntPtr.Zero, IntPtr.Zero, 2, 0x1F0003); }   // (2: high resolution; all access)
            long due = -w * 10000;   // (from now, in 100 ns)
            if (napTimer != IntPtr.Zero && SetWaitableTimer(napTimer, ref due, 0, IntPtr.Zero, IntPtr.Zero, false)) WaitForSingleObject(napTimer, 1000);
            else Thread.Sleep((int)Math.Min(w, 250));
        }
    }

    // the two 06 93 feature reports of a full picture (left and right halves, 64 x 64 each): pixels column by column,
    // bit x * h + y, the lowest bit the top pixel
    internal static List<byte[]> Packets(bool[,] px)
    {
        var list = new List<byte[]>();
        for (int x0 = 0; x0 < 128; x0 += 64)
        {
            var rep = new byte[6 + 64 * 64 / 8];
            rep[0] = 0x06; rep[1] = 0x93; rep[2] = (byte)x0; rep[3] = 0; rep[4] = 64; rep[5] = 64;
            for (int x = 0; x < 64; x++)
                for (int y = 0; y < 64; y++)
                    if (px[x0 + x, y]) { int bit = x * 64 + y; rep[6 + bit / 8] |= (byte)(1 << (bit % 8)); }
            list.Add(rep);
        }
        return list;
    }
}

// ---- plain Windows HID: find by interface path, caps, overlapped read with a timeout, write, feature. Several programs
// can hold the same collection at once; each open handle gets its own copy of every input report, so answers meant for
// GG or G HUB reach us too (told apart by the command byte or the software id) ----
sealed class HidDev : IDisposable
{
    [StructLayout(LayoutKind.Sequential)]
    struct Caps
    {
        public ushort Usage, UsagePage, InputReportByteLength, OutputReportByteLength, FeatureReportByteLength;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 17)] public ushort[] Reserved;
        public ushort NumberLinkCollectionNodes, NumberInputButtonCaps, NumberInputValueCaps, NumberInputDataIndices,
            NumberOutputButtonCaps, NumberOutputValueCaps, NumberOutputDataIndices,
            NumberFeatureButtonCaps, NumberFeatureValueCaps, NumberFeatureDataIndices;
    }
    [DllImport("hid.dll")] static extern void HidD_GetHidGuid(out Guid g);
    [DllImport("hid.dll", SetLastError = true)] static extern bool HidD_GetPreparsedData(SafeFileHandle h, out IntPtr pp);
    [DllImport("hid.dll")] static extern bool HidD_FreePreparsedData(IntPtr pp);
    [DllImport("hid.dll")] static extern int HidP_GetCaps(IntPtr pp, out Caps caps);
    [DllImport("hid.dll", SetLastError = true)] static extern bool HidD_SetFeature(SafeFileHandle h, byte[] buf, int len);
    [DllImport("hid.dll", SetLastError = true)] static extern bool HidD_SetOutputReport(SafeFileHandle h, byte[] buf, int len);
    [DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode)] static extern int CM_Get_Device_Interface_List_Size(out int len, ref Guid g, string id, int flags);
    [DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode)] static extern int CM_Get_Device_Interface_List(ref Guid g, string id, char[] buf, int len, int flags);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr sa, uint disp, uint flags, IntPtr tmpl);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool ReadFile(SafeFileHandle h, IntPtr buf, int n, IntPtr read, IntPtr ov);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool WriteFile(SafeFileHandle h, IntPtr buf, int n, IntPtr written, IntPtr ov);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetOverlappedResult(SafeFileHandle h, IntPtr ov, out int n, bool wait);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CancelIoEx(SafeFileHandle h, IntPtr ov);

    public ushort UsagePage, Usage;
    public int InLen, OutLen, FeatLen, LastError;
    SafeFileHandle h;
    IntPtr rov, wov;
    readonly ManualResetEvent rev = new ManualResetEvent(false), wev = new ManualResetEvent(false);
    byte[] rbuf; GCHandle rpin; bool pending;

    public WaitHandle ReadEvent { get { return rev; } }

    public static List<string> Paths(string idPart)
    {
        Guid g; HidD_GetHidGuid(out g);
        var list = new List<string>();
        int len;
        if (CM_Get_Device_Interface_List_Size(out len, ref g, null, 0) != 0 || len < 2) return list;
        var buf = new char[len];
        if (CM_Get_Device_Interface_List(ref g, null, buf, len, 0) != 0) return list;
        foreach (string p in new string(buf).Split('\0'))
            if (p.Length > 0 && p.ToLowerInvariant().Contains(idPart)) list.Add(p);
        list.Sort(StringComparer.OrdinalIgnoreCase);
        return list;
    }

    // opened for read and write, overlapped; null when it can't be (in use only for reading by someone, gone)
    public static HidDev Open(string path)
    {
        var h = CreateFile(path, 0xC0000000u, 3, IntPtr.Zero, 3, 0x40000000u, IntPtr.Zero);
        if (h.IsInvalid) { h.Dispose(); return null; }
        var d = new HidDev(); d.h = h;
        IntPtr pp;
        if (HidD_GetPreparsedData(h, out pp))
        {
            Caps c; HidP_GetCaps(pp, out c);
            d.UsagePage = c.UsagePage; d.Usage = c.Usage;
            d.InLen = c.InputReportByteLength; d.OutLen = c.OutputReportByteLength; d.FeatLen = c.FeatureReportByteLength;
            HidD_FreePreparsedData(pp);
        }
        d.rov = NewOv(d.rev); d.wov = NewOv(d.wev);
        d.rbuf = new byte[Math.Max(d.InLen, 1)];
        d.rpin = GCHandle.Alloc(d.rbuf, GCHandleType.Pinned);
        return d;
    }

    static IntPtr NewOv(ManualResetEvent ev)
    {
        IntPtr p = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(NativeOverlapped)));
        var o = new NativeOverlapped(); o.EventHandle = ev.SafeWaitHandle.DangerousGetHandle();
        Marshal.StructureToPtr(o, p, false);
        return p;
    }
    static void ResetOv(IntPtr p, ManualResetEvent ev)
    {
        ev.Reset();
        var o = new NativeOverlapped(); o.EventHandle = ev.SafeWaitHandle.DangerousGetHandle();
        Marshal.StructureToPtr(o, p, false);
    }

    // one read always waiting on the device
    public void Arm()
    {
        if (pending || InLen == 0) return;
        ResetOv(rov, rev);
        if (!ReadFile(h, rpin.AddrOfPinnedObject(), InLen, IntPtr.Zero, rov))
        {
            int e = Marshal.GetLastWin32Error();
            if (e != 997) throw new IOException("read failed, Windows error " + e);
        }
        pending = true;
    }

    // one input report, or null after ms milliseconds
    public byte[] Take(int ms)
    {
        if (InLen == 0) return null;
        Arm();
        if (!rev.WaitOne(ms)) return null;
        int n;
        bool ok = GetOverlappedResult(h, rov, out n, false);
        pending = false;
        if (!ok) throw new IOException("read failed, Windows error " + Marshal.GetLastWin32Error());
        var r = new byte[n]; Array.Copy(rbuf, r, n);
        return r;
    }

    public List<byte[]> TakeAll()
    {
        var l = new List<byte[]>(); byte[] r;
        while ((r = Take(0)) != null) l.Add(r);
        return l;
    }

    // an output report, padded to the collection's length; false when the device didn't take it (LastError says why)
    public bool Write(byte[] report, int ms)
    {
        LastError = 0;
        var buf = new byte[OutLen]; Array.Copy(report, buf, Math.Min(report.Length, OutLen));
        var pin = GCHandle.Alloc(buf, GCHandleType.Pinned);
        try
        {
            ResetOv(wov, wev);
            if (!WriteFile(h, pin.AddrOfPinnedObject(), OutLen, IntPtr.Zero, wov))
            {
                int e = Marshal.GetLastWin32Error();
                if (e != 997) { LastError = e; return false; }
            }
            int n;
            if (!wev.WaitOne(ms)) { CancelIoEx(h, wov); GetOverlappedResult(h, wov, out n, true); LastError = -1; return false; }
            bool ok = GetOverlappedResult(h, wov, out n, false);
            if (!ok) LastError = Marshal.GetLastWin32Error();
            return ok;
        }
        finally { pin.Free(); }
    }

    // an output report through the control pipe (SET_REPORT), padded like Write: no wait for the device's next look at
    // its OUT endpoint, which WriteFile has (32 ms on the headset base)
    public bool SetOutput(byte[] report)
    {
        LastError = 0;
        var buf = new byte[OutLen]; Array.Copy(report, buf, Math.Min(report.Length, OutLen));
        bool ok = HidD_SetOutputReport(h, buf, OutLen);
        if (!ok) LastError = Marshal.GetLastWin32Error();
        return ok;
    }

    public bool SetFeature(byte[] report)
    {
        var buf = new byte[FeatLen]; Array.Copy(report, buf, Math.Min(report.Length, FeatLen));
        return HidD_SetFeature(h, buf, FeatLen);
    }

    public void Dispose()
    {
        if (h == null) return;
        if (pending) { int n; CancelIoEx(h, rov); GetOverlappedResult(h, rov, out n, true); pending = false; }
        h.Dispose(); h = null;
        if (rpin.IsAllocated) rpin.Free();
        if (rov != IntPtr.Zero) Marshal.FreeHGlobal(rov);
        if (wov != IntPtr.Zero) Marshal.FreeHGlobal(wov);
    }
}

// ---- the headset: Arctis Nova Pro Wireless base station. 06 B0 ("wireless_settings" in GG's own list), its answer:
// [6] the headset's battery 0-8, [7] the spare's (charging in the base) 0-8, [14] radio link (1 not paired, 4 paired
// but off, 8 connected), [15] the headset's power (1 off, 2 charging by cable, 8 on) ----
sealed class Arctis : IDisposable
{
    public HidDev Cmd, Push;   // Cmd = the FFC0 collection (report 06), Push = the FF00 collection (report 07)
    public readonly List<byte[]> Pushes = new List<byte[]>();
    public readonly List<byte[]> Inbox = new List<byte[]>();   // what came in on the command collection that was nobody's answer (the key test mode's reports)
    public bool NoWait;   // the base may be gone: gate 4 only tries the quick pipe
    public string Pid;    // which base station: "12e0" the PC one (his, the one proven), "12e5" / "225d" the Xbox ones

    public static Arctis Open()
    {
        var a = new Arctis();
        foreach (string id in Ids)
        {
            foreach (string p in HidDev.Paths("vid_1038&pid_" + id + "&mi_04"))
            {
                var d = HidDev.Open(p); if (d == null) continue;
                if (d.UsagePage == 0xFFC0 && a.Cmd == null) a.Cmd = d;
                else if (d.UsagePage == 0xFF00 && a.Push == null) a.Push = d;
                else d.Dispose();
            }
            if (a.Cmd != null) { a.Pid = id; break; }   // (one base: its command and push collections, the release review 11-15)
            if (a.Push != null) { a.Push.Dispose(); a.Push = null; }
        }
        if (a.Cmd == null) { a.Dispose(); return null; }
        return a;
    }
    // the base stations: the PC version (his), the Xbox version and the Xbox white one (11-15: HeadsetControl and ggoled
    // drive all three the same way, interface 4, report 06; only the PC version was proven here)
    static readonly string[] Ids = { "12e0", "12e5", "225d" };

    // GATE 1: output reports. The status questions B0, B7, 10 (its firmware), 80 (its screen settings) and 20 (its volume; ggoled and Arctis Sound Manager ask it too),
    // and 95 (the screen back to the base's own view). Nothing else.
    bool Out(byte cmd)
    {
        if (cmd != 0xB0 && cmd != 0xB7 && cmd != 0x20 && cmd != 0x95 && cmd != 0x10 && cmd != 0x80) throw new InvalidOperationException("blocked headset command " + cmd.ToString("x2"));
        return Cmd.Write(new byte[] { 0x06, cmd }, 1000);
    }

    // GATE 2: feature reports. Only 06 93 (draw a block of pixels), inside 128 x 64.
    public bool Feature(byte[] report)
    {
        if (report.Length < 6 || report[0] != 0x06 || report[1] != 0x93) throw new InvalidOperationException("blocked screen report");
        if (report[2] > 127 || report[3] > 63 || report[4] == 0 || report[4] > 64 || report[5] == 0 || report[5] > 64 || report[5] % 8 != 0)
            throw new InvalidOperationException("screen block outside 128 x 64");
        return Cmd.SetFeature(report);
    }

    // 06 95 through the control pipe first: 2 ms, where Out (WriteFile) waits up to 32 ms (knob test 3, 11-13); Out
    // from then on if the base ever refuses it that way
    static bool slowBack;
    public bool ScreenBack()
    {
        if (!slowBack) { if (Cmd.SetOutput(new byte[] { 0x06, 0x95 })) return true; slowBack = true; }
        return Out(0x95);
    }

    // GATE 4 (11-13): the volume knob with none of the base's own screens. Exactly these reports and no other, ever:
    // 06 1b 81 01 00 / 01 (the firmware's key test mode off / on), 06 1b 8a 01 fd then 16 or 12 (the OLED controller
    // locked / unlocked), 06 25 <0x38 - level> (the volume). Read from firmware 1.29.27 and proven on it; Batt sends
    // them to that firmware only. Through the control pipe (about 2 ms each, in order)
    bool Raw(params byte[] r)
    {
        bool ok = r.Length == 5 && r[0] == 0x06 && r[1] == 0x1b && r[3] == 0x01 && ((r[2] == 0x81 && r[4] <= 1) || (r[2] == 0x8a && (r[4] == 0xfd || r[4] == 0x16 || r[4] == 0x12)));
        ok |= r.Length == 3 && r[0] == 0x06 && r[1] == 0x25 && r[2] <= 0x38;
        ok |= r.Length == 3 && r[0] == 0x06 && r[1] == 0x85 && r[2] >= 1 && r[2] <= 10;   // (the brightness, 11-14: only when he moves its slider; never 06 09, but the base's own save after a wheel turn keeps it)
        if (!ok) throw new InvalidOperationException("blocked headset report");
        return Cmd.SetOutput(r) || (!NoWait && Cmd.Write(r, 1000));
    }
    public bool KeyTest(bool on) { return Raw(0x06, 0x1b, 0x81, 0x01, (byte)(on ? 1 : 0)); }
    // HEAL (his yes 11-15, hs-knob's list 11-14): the panel's own set up again, one byte per report, from this fixed list only,
    // then locked (lockAfter false: left unlocked, for Refresh). Never 81 (re-posted as contrast 0), never ae (display off)
    static readonly byte[] HealBytes = { 0xe3, 0xe3, 0xfd, 0x12, 0xfd, 0x12, 0xd5, 0xa0, 0xa8, 0x3f, 0xd3, 0x00, 0x40, 0x20, 0x00, 0xa1, 0xc8, 0xda, 0x12, 0xd9, 0x22, 0xdb, 0x34, 0x2e, 0xa4, 0xa6, 0x22, 0x00, 0x07, 0x21, 0x00, 0x7f, 0xaf, 0xfd, 0x16 };
    public bool Heal(bool lockAfter) { bool ok = true; int n = lockAfter ? HealBytes.Length : HealBytes.Length - 2; for (int k = 0; k < n; k++) ok &= Cmd.SetOutput(new byte[] { 0x06, 0x1b, 0x8a, 0x01, HealBytes[k] }); return ok; }
    public bool PanelLock(bool on) { return Raw(0x06, 0x1b, 0x8a, 0x01, 0xfd) & Raw(0x06, 0x1b, 0x8a, 0x01, (byte)(on ? 0x16 : 0x12)); }
    public bool Bright(int b) { if (b < 1 || b > 10) throw new InvalidOperationException("brightness outside 1 to 10"); return Raw(0x06, 0x85, (byte)b); }
    // GATE 5 (11-15, his "Yes, A + save"): the headset's own settings, exactly these and their ranges (hwdeck\local\
    // hs-settings-1115\findings.md, each read in firmware 1.29.27): 06 bd 0..2 noise control, b9 1..10 transparency,
    // c1 0..6 auto off, 2e 0..4 EQ preset, 31 <1..10> <0..40> one custom band, 37 1..10 mic volume, 39 0..3 sidetone,
    // bf 1..10 mute light, 27 1..2 gain, and 06 09 (save to the base's storage). Through the control pipe, as Raw
    public bool Setting(byte[] r)
    {
        bool ok = r != null && r.Length >= 2 && r[0] == 0x06;
        if (ok)
        {
            byte c = r[1]; int n = r.Length - 2, v = n > 0 ? r[2] : -1;
            if (c == 0x09) ok = n == 0;
            else if (c == 0xBD) ok = n == 1 && v <= 2;
            else if (c == 0xB9 || c == 0x37 || c == 0xBF) ok = n == 1 && v >= 1 && v <= 10;
            else if (c == 0xC1) ok = n == 1 && v <= 6;
            else if (c == 0x2E) ok = n == 1 && v <= 4;
            else if (c == 0x31) ok = n == 2 && v >= 1 && v <= 10 && r[3] <= 40;
            else if (c == 0x39) ok = n == 1 && v <= 3;
            else if (c == 0x27) ok = n == 1 && (v == 1 || v == 2);
            else ok = false;
        }
        if (!ok) throw new InvalidOperationException("blocked headset setting");
        return Cmd.SetOutput(r) || (!NoWait && Cmd.Write(r, 1000));
    }
    public bool SetLevel(int level) { if (level < 0 || level > 0x38) throw new InvalidOperationException("volume level outside 0 to 56"); return Raw(0x06, 0x25, (byte)(0x38 - level)); }

    public void CollectPushes() { if (Push != null) Pushes.AddRange(Push.TakeAll()); Inbox.AddRange(Cmd.TakeAll()); if (Inbox.Count > 256) Inbox.RemoveRange(0, Inbox.Count - 256); }

    // one question (06 B0, 06 B7, 06 20, 06 10 or 06 80) and its answer, or null when none came within a second
    public byte[] Ask(byte cmd, int timeoutMs = 1000)   // (timeoutMs: the wheel's 10 ms polls wait 40 ms at most, the review 11-14)
    {
        CollectPushes();
        if (!Out(cmd)) return null;
        var sw = Stopwatch.StartNew();
        while (sw.ElapsedMilliseconds < timeoutMs)
        {
            var r = Cmd.Take((int)Math.Max(1, timeoutMs - sw.ElapsedMilliseconds));
            if (r == null) break;
            if (r.Length >= 16 && r[0] == 0x06 && r[1] == cmd) return r;
            Inbox.Add(r);   // (not the answer: a report of the key test mode, or someone else's answer)
        }
        return null;
    }

    public void Dispose()
    {
        if (Cmd != null) Cmd.Dispose();
        if (Push != null) Push.Dispose();
    }
}

// ---- the mouse: HID++ over the LIGHTSPEED receiver (Logitech's documented calls; Solaar and LGSTrayBattery use the
// same). A request: 10 <device> <feature index> <function << 4 | software id> p0 p1 p2; its answer has the same first
// 4 bytes (often as a long 11 report). Errors: 10 <dev> 8F .. (HID++ 1.0, from the receiver: 8 "unknown device" = the
// mouse is in deep sleep or off) or 11 <dev> FF .. (2.0). Software id 0E (G HUB uses 0D, Solaar 0B) ----
sealed class Lightspeed : IDisposable
{
    public HidDev Short, Long;
    readonly List<byte[]> pushes = new List<byte[]>();
    const byte Sw = 0x0E;
    const int Wait = 2500;   // (in light sleep it answers in 300 to 1000 ms, measured 11-12)

    public static Lightspeed Open()
    {
        var l = new Lightspeed();
        foreach (string p in HidDev.Paths("vid_046d&pid_c54d&mi_02"))
        {
            var d = HidDev.Open(p); if (d == null) continue;
            if (d.UsagePage == 0xFF00 && d.Usage == 0x0001 && l.Short == null) l.Short = d;
            else if (d.UsagePage == 0xFF00 && d.Usage == 0x0002 && l.Long == null) l.Long = d;
            else d.Dispose();
        }
        if (l.Short == null || l.Long == null) { l.Dispose(); return null; }
        return l;
    }

    // GATE 3: HID++ feature calls, reads only: 0000 root (0 getFeature, 1 ping), 1004 unified battery (1 getStatus)
    public byte[] Call(byte dev, int feature, byte index, int fn, byte[] args, out string err)
    {
        if (!((feature == 0x0000 && (fn == 0 || fn == 1)) || (feature == 0x1004 && fn == 1)))
            throw new InvalidOperationException("blocked HID++ call " + feature.ToString("x4") + " fn " + fn);
        var req = new byte[7];
        req[0] = 0x10; req[1] = dev; req[2] = index; req[3] = (byte)((fn << 4) | Sw);
        if (args != null) Array.Copy(args, 0, req, 4, Math.Min(3, args.Length));
        err = null;
        pushes.AddRange(Short.TakeAll()); pushes.AddRange(Long.TakeAll());
        if (!Short.Write(req, 1000)) { err = "the receiver did not take it (Windows error " + Short.LastError + ")"; if (Short.LastError > 0) throw new IOException(err); return null; }
        var sw = Stopwatch.StartNew();
        var evs = new WaitHandle[] { Short.ReadEvent, Long.ReadEvent };
        while (sw.ElapsedMilliseconds < Wait)
        {
            Short.Arm(); Long.Arm();
            if (WaitHandle.WaitAny(evs, (int)Math.Max(1, Wait - sw.ElapsedMilliseconds)) == WaitHandle.WaitTimeout) break;
            foreach (var d in new[] { Short, Long })
            {
                var r = d.Take(0);
                if (r == null) continue;
                if (r.Length >= 7 && r[1] == req[1])
                {
                    if (r[2] == req[2] && r[3] == req[3]) { var t = new byte[r.Length - 4]; Array.Copy(r, 4, t, 0, t.Length); return t; }
                    if ((r[2] == 0x8F || r[2] == 0xFF) && r[3] == req[2] && r[4] == req[3]) { err = (r[2] == 0x8F ? "HID++ 1.0 error " : "HID++ 2.0 error ") + r[5]; return null; }
                }
                pushes.Add(r);
            }
        }
        err = "no answer in " + Wait + " ms";
        return null;
    }

    // what came in by itself since the last look (the receiver's link changes, the mouse's battery events)
    public List<byte[]> Listen()
    {
        var l = new List<byte[]>(pushes); pushes.Clear();
        l.AddRange(Short.TakeAll()); l.AddRange(Long.TakeAll());
        return l;
    }

    // the battery: 1 read (percent, charging: 0 no, 1 / 2 charging, 3 full), 0 asleep or off, -1 no answer. dev and idx
    // are found once (the ping, getFeature 1004) and kept; a failed call finds them again next time
    public int Status(ref byte dev, ref byte idx, out int pct, out int chg)
    {
        pct = chg = -1; string err;
        if (dev == 0)
        {
            bool sleepy = false;
            for (byte d = 1; d <= 6 && dev == 0; d++)
            {
                byte mark = (byte)(0x40 + d);
                var r = Call(d, 0x0000, 0, 1, new byte[] { 0, 0, mark }, out err);
                if (r != null && r.Length >= 3 && r[2] == mark) dev = d;
                else if (d == 1 && Sleepy(err)) sleepy = true;
            }
            if (dev == 0) return sleepy ? 0 : -1;
            idx = 0;
        }
        if (idx == 0)
        {
            var r = Call(dev, 0x0000, 0, 0, new byte[] { 0x10, 0x04, 0 }, out err);
            if (r == null || r[0] == 0) { bool s = Sleepy(err); if (!s) dev = 0; return s ? 0 : -1; }
            idx = r[0];
        }
        var st = Call(dev, 0x1004, idx, 1, null, out err);
        if (st == null || st.Length < 3) { if (Sleepy(err)) return 0; idx = 0; return -1; }
        pct = st[0]; chg = st[2];
        return 1;
    }
    static bool Sleepy(string err) { return err != null && (err == "HID++ 1.0 error 8" || err == "HID++ 1.0 error 9"); }

    public void Dispose()
    {
        if (Short != null) Short.Dispose();
        if (Long != null) Long.Dispose();
    }
}
}
// ==== headset end ====
