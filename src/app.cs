// HW Deck: a dashboard for whatever HWiNFO measures. The host reads HWiNFO's shared memory, keeps history, logs
// warnings and game sessions, and stores files; the page (web\index.html in WebView2) owns the layout. Every
// reading has a key that survives restarts and renames: sensor id.instance/reading id, e.g. f0000501.0/01000000.
//   HWDeck.exe            normal start
//   HWDeck.exe -min       start in the tray
//   --fake [N]            a made-up machine with N readings instead of HWiNFO (tests, demos)
//   --data <dir>          keep layouts, slots, logs and history in <dir> instead of %APPDATA%\HW Deck
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

[assembly: System.Reflection.AssemblyTitle("HW Deck")]
[assembly: System.Reflection.AssemblyProduct("HW Deck")]
[assembly: System.Reflection.AssemblyDescription("A dashboard for whatever HWiNFO measures")]
[assembly: System.Reflection.AssemblyCopyright("MIT License")]
[assembly: System.Reflection.AssemblyVersion("1.5.6.0")]
[assembly: System.Reflection.AssemblyFileVersion("1.5.6.0")]
[assembly: System.Reflection.AssemblyInformationalVersion(AppInfo.Version)]

static class AppInfo
{
    public const string Version = "1.5.6";
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
    byte[] sbuf = new byte[0], rbuf = new byte[0];
    ulong idHash; long namesAt;
    static readonly Encoding Ansi = Encoding.GetEncoding(1252);
    static double Fin(double v) { return double.IsInfinity(v) ? double.NaN : v; }

    public override void Poll()
    {
        try
        {
            using (var mmf = MemoryMappedFile.OpenExisting("Global\\HWiNFO_SENS_SM2", MemoryMappedFileRights.Read))
            using (var acc = mmf.CreateViewAccessor(0, 0, MemoryMappedFileAccess.Read))
            {
                if (acc.ReadUInt32(0) != SIG) { Status = "missing"; return; }   // "DEAD" once HWiNFO shuts it
                long poll = acc.ReadInt64(12);
                uint sOfs = acc.ReadUInt32(20), sSize = acc.ReadUInt32(24), sCount = acc.ReadUInt32(28);
                uint rOfs = acc.ReadUInt32(32), rSize = acc.ReadUInt32(36), rCount = acc.ReadUInt32(40);
                if (sSize < 264 || rSize < 316 || sSize > 8192 || rSize > 8192 || sCount > 100000 || rCount > 200000) { Status = "missing"; return; }
                long sLen = (long)sSize * sCount, rLen = (long)rSize * rCount;
                // a header that promises more than the mapping holds is a half-written or foreign block, not readings
                if (sOfs + sLen > acc.Capacity || rOfs + rLen > acc.Capacity) { Status = "missing"; return; }
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
        catch (Exception) { Status = "missing"; }
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
        if (!Same(sens, reads)) { Sensors = sens; Readings = reads; Version++; }
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
            foreach (var spec in new[] { new[] { "4", "Current" }, new[] { "5", "Power" } })
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
    public const string GameTimeKey = "hwdeck.0/gtime";
    public Func<double> GameMin;                                // how long the game session has run, in minutes (NaN: no game)
    public readonly List<Extra> Extras = new List<Extra>();     // a build's own readings (see Extra), after HW Deck's
    int innerVersion = -1, extraVersion = -1, connAt = -1, framesAt = -1, gtAt = -1; bool framesOn;
    int[] extraAt = new int[0];                                 // where each extra's readings start
    public DeckSource(Source inner) { Inner = inner; }
    public override void Poll()
    {
        Inner.Poll();
        foreach (var x in Extras) x.Poll();
        Status = Inner.Status; Age = Inner.Age; PmProc = Inner.PmProc;
        int ev = Extras.Count; foreach (var x in Extras) ev = ev * 31 + x.Version;
        bool fo = Frames != null && Frames.On;
        if (Inner.Version != innerVersion || ev != extraVersion || fo != framesOn)
        {
            innerVersion = Inner.Version; extraVersion = ev; framesOn = fo;
            Sensors = new List<Sensor>(Inner.Sensors); Readings = new List<Reading>(Inner.Readings);
            extraAt = new int[Extras.Count]; connAt = -1; framesAt = -1; gtAt = -1;
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
    public void Second(bool game)
    {
        foreach (var x in Extras) x.Second();   // first: the bottleneck may go by a build's own measurements
        Bneck.Second(Inner, game);
        if (Values.Length > Inner.Readings.Count) Values[Inner.Readings.Count] = Bneck.Value;
        if (Frames != null) Frames.Second();
        CopyFrames();
        CopyExtras();
    }
}

// what limits the fps while a game runs, one call a second: the GPU at 95%+ is gpu-bound ('g'); under 85% with the
// busiest CPU thread at 80%+ is cpu-bound ('c'); otherwise an fps cap or vsync ('f'); 85-95% keeps the previous call.
// Read from HWiNFO by name: GPU core load, and Max CPU/Thread Usage (else the busiest per-thread or per-core usage)
class Bottleneck
{
    public const string Key = "hwdeck.0/bneck";
    static readonly Regex MaxRe = new Regex(@"^Max CPU/Thread Usage$"), ThreadRe = new Regex(@"^(?:[PE]-)?Core ?\d+(?: T\d+)? Usage$", RegexOptions.IgnoreCase);
    public static bool Named(Regex re, Reading r) { return re.IsMatch(r.Label) || (!string.IsNullOrEmpty(r.Orig) && re.IsMatch(r.Orig)); }
    int gpuI = -1, maxI = -1; int[] threads = new int[0];
    char last = '-';
    public char Call = '-';                 // this second's; '-' no game, no readings or HWiNFO not sharing
    public char Live = '-';                 // the same call game or not (the cell shows it outside a game too); '-' no readings
    public double Value = double.NaN;       // this second's call for the history: 1 gpu, 2 cpu, 3 capped
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
        threads = th.ToArray();
        Inputs = new object[] { gpuI >= 0 ? src.Readings[gpuI].Key : OwnGpu != null ? OwnGpuKey : null,
                                maxI >= 0 ? src.Readings[maxI].Key : threads.Length == 0 && OwnCpu != null ? OwnCpuKey : null, threads.Length };
    }
    static double At(Source src, int i) { return i >= 0 && i < src.Values.Length && !double.IsInfinity(src.Values[i]) ? src.Values[i] : double.NaN; }
    public void Second(Source src, bool game)
    {
        double gpu = At(src, gpuI), cpu = At(src, maxI);
        if (maxI < 0) foreach (int i in threads) { double v = At(src, i); if (!double.IsNaN(v) && (double.IsNaN(cpu) || v > cpu)) cpu = v; }
        if (gpuI < 0 && OwnGpu != null) gpu = OwnGpu();
        if (maxI < 0 && threads.Length == 0 && OwnCpu != null) cpu = OwnCpu();
        char live = '-';
        if (src.Status == "ok" && !double.IsNaN(gpu) && !double.IsNaN(cpu))
        {
            live = gpu >= 95 ? 'g' : gpu < 85 ? (cpu >= 80 ? 'c' : 'f') : last != '-' ? last : gpu >= 90 ? 'g' : cpu >= 80 ? 'c' : 'f';
        }
        if (live != '-') last = live;   // (a second with no value keeps the last call for the band)
        Live = live;
        char call = game ? live : '-';
        Call = call;
        // 6. each second's call as it is, the same ones the game report counts; the page shows the most common of the last 5 s
        Value = call == 'g' ? 1 : call == 'c' ? 2 : call == 'f' ? 3 : double.NaN;
        Shares[0] = call == 'g' ? 1 : 0; Shares[1] = call == 'c' ? 1 : 0; Shares[2] = call == 'f' ? 1 : 0;
    }
}

// a GPU's 12V-2x6 (12VHPWR) power connector, when HWiNFO reports its pins ("GPU 12VHPWR Pin1 Current" ... and their
// Power): its most loaded pin as a reading of HW Deck's own (a pin is rated 9.5 A; a healthy connector at a 600 W limit
// peaks near 9.1 A a pin), and whether one pin carries 1.5x its share of the load, the early sign of a bad contact
// (judged from 15 A up: at idle a spread means nothing). Its cell draws the pins (kind "12v" in deck.js)
class Connector
{
    public const string Key = "hwdeck.0/12v";
    static readonly Regex PinA = new Regex(@"^GPU 12VHPWR Pin(\d+) Current$"), PinW = new Regex(@"^GPU 12VHPWR Pin(\d+) Power$");
    int[] a = new int[0], w = new int[0];
    public object[] Keys = new object[0];       // for the page: the pins' current keys, then their power keys
    public double Worst = double.NaN, Share;    // the most loaded pin (A); its load against the average
    public int Hot = -1;                        // which pin that is (from 0)
    public bool Lopsided;                       // a pin over 1.5x its share, at 15 A or more in all
    public double[] A = new double[0], W = new double[0];
    public bool Has { get { return a.Length >= 2; } }
    public void Find(Source src)
    {
        var ma = new SortedDictionary<int, int>(); var mw = new SortedDictionary<int, int>();
        for (int i = 0; i < src.Readings.Count; i++)
        {
            var r = src.Readings[i]; Match m;
            if ((m = PinA.Match(r.Label)).Success || (!string.IsNullOrEmpty(r.Orig) && (m = PinA.Match(r.Orig)).Success)) { int k = int.Parse(m.Groups[1].Value); if (!ma.ContainsKey(k)) ma[k] = i; }
            else if ((m = PinW.Match(r.Label)).Success || (!string.IsNullOrEmpty(r.Orig) && (m = PinW.Match(r.Orig)).Success)) { int k = int.Parse(m.Groups[1].Value); if (!mw.ContainsKey(k)) mw[k] = i; }
        }
        a = ma.Values.ToArray(); w = mw.Values.ToArray();
        Keys = new object[] { a.Select(i => (object)src.Readings[i].Key).ToList(), w.Select(i => (object)src.Readings[i].Key).ToList() };
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
    public volatile int Pid;                // the game's process (0: none): only its frames are kept
    readonly long[] ring = new long[16384]; int head, count, ringPid;   // present times (QPC), the newest at head - 1
    volatile int seenPid;                   // the last process whose frames came in (it presents through DXGI)
    int lastPid; long pidAt;                // the process the last second looked at, and since when (QPC)
    readonly object lk = new object();
    public string State = "off";            // off | on | denied (no rights: not admin, not in Performance Log Users) | failed
    public bool On { get { return State == "on"; } }
    public double Fps = double.NaN, Low = double.NaN, Ft = double.NaN;   // this second's, for the game (NaN: no game)
    public Frames(string name) { this.name = name; cb = OnRecord; stallAt = unchecked(Environment.TickCount - 10000); }

    IntPtr Props()
    {
        IntPtr p = Marshal.AllocHGlobal(PropsSize + NameMax * 2);
        for (int i = 0; i < PropsSize + NameMax * 2; i += 4) Marshal.WriteInt32(p, i, 0);
        Marshal.WriteInt32(p, 0, PropsSize + NameMax * 2);   // Wnode.BufferSize
        Marshal.WriteInt32(p, 40, 1);                        // Wnode.ClientContext: QPC time stamps
        Marshal.WriteInt32(p, 44, 0x20000);                  // Wnode.Flags: WNODE_FLAG_TRACED_GUID
        Marshal.WriteInt32(p, 48, 64);                       // BufferSize (KB)
        Marshal.WriteInt32(p, 64, 0x100);                    // LogFileMode: EVENT_TRACE_REAL_TIME_MODE
        Marshal.WriteInt32(p, 68, 1);                        // FlushTimer (s): frames reach the counter within a second
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
        try
        {
            StopNamed();
            IntPtr p = Props(); int err;
            try { err = StartTraceW(out session, name, p); } finally { Marshal.FreeHGlobal(p); }
            if (err != 0) { State = err == 5 ? "denied" : "failed"; return; }   // 5: access denied
            var g = Dxgi;
            err = EnableTraceEx2(session, ref g, 1 /*EVENT_CONTROL_CODE_ENABLE_PROVIDER*/, 5, 0, 0, 0, IntPtr.Zero);
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
        try { StopNamed(); } catch { }
        try { CloseTrace(trace); } catch { }
        trace = 0;
        lock (lk) { count = 0; }
        Fps = Low = Ft = double.NaN;
    }
    // the trace's thread, for every DXGI event of every process: EVENT_HEADER.Flags at 4, ProcessId at 12, TimeStamp at
    // 16, EventDescriptor.Id at 40; EVENT_RECORD.UserDataLength at 86, UserData at 96: Present_Start's swap chain (a
    // pointer, 4 bytes from a 32-bit process) then its Flags
    void OnRecord(IntPtr rec)
    {
        if (Marshal.ReadInt16(rec, 40) != 42) return;
        int pid = Marshal.ReadInt32(rec, 12);
        if (pid == 0 || pid != Pid) return;
        int at = (Marshal.ReadInt16(rec, 4) & 0x20) != 0 ? 4 : 8;   // EVENT_HEADER_FLAG_32_BIT_HEADER
        IntPtr data = Marshal.ReadIntPtr(rec, 96);
        if (data != IntPtr.Zero && Marshal.ReadInt16(rec, 86) >= at + 4 && (Marshal.ReadInt32(data, at) & 1) != 0) return;   // DXGI_PRESENT_TEST
        long ts = Marshal.ReadInt64(rec, 16);
        lock (lk)
        {
            if (ringPid != pid) { ringPid = pid; count = 0; }
            ring[head] = ts; head = (head + 1) % ring.Length; if (count < ring.Length) count++;
        }
        seenPid = pid;
    }
    // once a second: the fps of the last second of frames that came in, the 1% low over the last 10 s (the 99th
    // percentile frame time), the frame time; no frames for 3 s (a paused or hidden game): 0 fps. A game that hasn't
    // presented through DXGI since it came to the front (Vulkan, OpenGL, DirectX 9, or just back from an alt-tab) has
    // no number yet: nothing, not 0 (its sessions take HWiNFO's fps instead, see Games.Feed)
    int stallAt;   // the last time the trace was asked again for frames that stopped coming (TickCount, compared unchecked)
    public void Second()
    {
        long f = System.Diagnostics.Stopwatch.Frequency, now = System.Diagnostics.Stopwatch.GetTimestamp();
        int pid = Pid;
        if (pid != lastPid) { lastPid = pid; pidAt = now; }
        if (!On || pid == 0) { Fps = Low = Ft = double.NaN; return; }
        // no frames for 3 s: a paused game, or another program that stopped its own trace of the same events turned
        // them off for everyone: asked again, at most every 5 s (cheap; a paused game simply stays at 0)
        if (double.IsNaN(Fps) || Fps == 0) { int n = Environment.TickCount; if (unchecked(n - stallAt) > 5000) { stallAt = n; var g = Dxgi; try { EnableTraceEx2(session, ref g, 1, 5, 0, 0, 0, IntPtr.Zero); } catch { } } }
        var ts = new List<long>();
        lock (lk)
        {
            if (ringPid != pid) count = 0;
            for (int i = count; i >= 1; i--) { long t = ring[(head - i + ring.Length) % ring.Length]; if (t >= now - 11 * f && t >= pidAt) ts.Add(t); }
        }
        ts.Sort();   // (events come one buffer per CPU, not quite in order)
        if (ts.Count == 0 && (seenPid != pid || now - pidAt < 3 * f)) { Fps = Low = Ft = double.NaN; return; }   // (not a DXGI game, or not yet)
        if (ts.Count == 0 || ts[ts.Count - 1] < now - 3 * f) { Fps = 0; Low = Ft = double.NaN; return; }
        long last = ts[ts.Count - 1];
        if (last - f < pidAt) { Fps = Low = Ft = double.NaN; return; }   // (in front for less than the whole second: a part of a second's frames)
        int n1 = ts.Count(t => t > last - f);
        Fps = n1;
        Ft = n1 > 0 ? 1000.0 / n1 : double.NaN;
        var gaps = new List<double>();
        // (a gap of a second or more is a pause, an alt-tab or a loading screen, not a frame of the game)
        for (int i = 1; i < ts.Count; i++) if (ts[i] > last - 10 * f) { double g = (ts[i] - ts[i - 1]) * 1000.0 / f; if (g < 1000) gaps.Add(g); }
        if (gaps.Count >= 30) { gaps.Sort(); double p99 = gaps[Math.Min(gaps.Count - 1, (int)Math.Ceiling(gaps.Count * 0.99) - 1)]; Low = p99 > 0 ? 1000.0 / p99 : double.NaN; }
        else Low = double.NaN;
    }
}

// what each reading did, for every reading (so a cell added now already has its past): the last 15 min at 1 s,
// 24 h of 1-minute averages and peaks, 7 days of 10-minute averages and peaks. The long ones are saved to hist.bin.
// All readings are sampled together, so which second / minute / block a ring slot holds is one array for all.
class History
{
    public const int SecLen = 900, MinLen = 1440, TenLen = 1008;
    class Track
    {
        public float[] Sec = NaNs(SecLen), MAvg = NaNs(MinLen), MMax = NaNs(MinLen), TAvg = NaNs(TenLen), TMax = NaNs(TenLen);
        public double MSum, MPeak = double.MinValue, TSum, TPeak = double.MinValue; public int MCnt, TCnt;
        public bool Share;   // 1 or 0 a second (the bottleneck's calls): a minute holds its part of the whole minute, not of the seconds sampled
        public double MVal(int len) { return Share ? MSum / len : MSum / MCnt; }
        public double TVal(int len) { return Share ? TSum / len : TSum / TCnt; }
    }
    readonly Dictionary<string, Track> tracks = new Dictionary<string, Track>();
    readonly long[] secAt = new long[SecLen];
    readonly int[] minAt = new int[MinLen], tenAt = new int[TenLen];
    Track[] byIndex = new Track[0];
    int version = -1, curMin = -1, curTen = -1;
    readonly string path;
    public History(string dir)
    {
        path = Path.Combine(dir, "hist.bin");
        for (int i = 0; i < MinLen; i++) minAt[i] = -1;
        for (int i = 0; i < TenLen; i++) tenAt[i] = -1;
        Load();
    }

    static float[] NaNs(int n) { var a = new float[n]; for (int i = 0; i < n; i++) a[i] = float.NaN; return a; }

    // once a second; moreKeys / more: readings only the history keeps (not in the catalog), NaN for none
    public void Sample(Source src, string[] moreKeys = null, double[] more = null)
    {
        if (held && (Source.Unix() >= retryAt || retryAt - Source.Unix() > 60)) Load();   // (or the clock set back)
        if (moreKeys != null) foreach (var k in moreKeys) { Track t; if (!tracks.TryGetValue(k, out t)) tracks[k] = t = new Track(); t.Share = true; }
        if (src.Version != version)
        {
            version = src.Version;
            byIndex = new Track[src.Readings.Count];
            for (int i = 0; i < byIndex.Length; i++)
            {
                Track t;
                if (!tracks.TryGetValue(src.Readings[i].Key, out t)) { t = new Track(); tracks[src.Readings[i].Key] = t; }
                byIndex[i] = t;
            }
        }
        long now = Source.Unix();
        int si = (int)(now % SecLen), minute = (int)(now / 60), ten = (int)(now / 600);
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
        foreach (var t in tracks.Values) t.Sec[si] = float.NaN;
        if (src.Status == "ok")
            for (int i = 0; i < byIndex.Length && i < src.Values.Length; i++)
            {
                double v = src.Values[i];
                if (double.IsNaN(v) || double.IsInfinity(v)) continue;
                var t = byIndex[i];
                t.Sec[si] = (float)v;
                t.MSum += v; t.MCnt++; if (v > t.MPeak) t.MPeak = v;
                t.TSum += v; t.TCnt++; if (v > t.TPeak) t.TPeak = v;
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
            }
        secAt[si] = now;
    }

    void CloseMin(Track t)
    {
        if (curMin >= 0) { int k = curMin % MinLen; t.MAvg[k] = t.MCnt > 0 ? (float)t.MVal(60) : float.NaN; t.MMax[k] = t.MCnt > 0 ? (float)t.MPeak : float.NaN; }
        t.MSum = 0; t.MCnt = 0; t.MPeak = double.MinValue;
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

    // 1 h, 6 h, 12 h, 24 h as 1-minute points or 7 days as 10-minute points, oldest first, averages and peaks
    public Dictionary<string, object> Range(string key, string range)
    {
        bool week = range == "7d";
        int span = week ? TenLen : range == "1h" ? 60 : range == "6h" ? 360 : range == "12h" ? 720 : 1440;
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
        return new Dictionary<string, object> { { "key", key }, { "range", week ? "7d" : range }, { "step", week ? 600 : 60 }, { "span", span * (week ? 600 : 60) }, { "avg", avg }, { "max", max }, { "end", (long)(week ? curTen : curMin) * (week ? 600 : 60) } };   // end: where the last column starts
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
        var list = new List<Snap>();
        foreach (var kv in tracks)
        {
            var t = kv.Value;
            bool any = false;
            for (int k = 0; k < MinLen && !any; k++) any = ma[k] > oldMin && !float.IsNaN(t.MAvg[k]);
            for (int k = 0; k < TenLen && !any; k++) any = ta[k] > oldTen && !float.IsNaN(t.TAvg[k]);
            if (!any) continue;   // nothing in the last week (a drive or adapter that's gone): not kept
            list.Add(new Snap { Key = kv.Key, MAvg = (float[])t.MAvg.Clone(), MMax = (float[])t.MMax.Clone(), TAvg = (float[])t.TAvg.Clone(), TMax = (float[])t.TMax.Clone() });
        }
        var open = openAcc; int oMin = openMin, oTen = openTen; var sAt = secSnap; var sTr = secTracks;
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
            }
            catch { }
            finally { saving = false; }
        };
        saving = true;
        if (wait) write(); else new System.Threading.Thread(write) { IsBackground = false, Priority = System.Threading.ThreadPriority.BelowNormal }.Start();
    }
    // at exit: the minute and 10-minute block in progress count too, and their sums are kept, so a restart inside
    // the same minute or block goes on adding to them
    Dictionary<string, double[]> openAcc; int openMin = -1, openTen = -1;
    long[] secSnap; Dictionary<string, float[]> secTracks;
    public void DropOpen() { openAcc = null; secSnap = null; secTracks = null; }   // the next saves are ordinary ones again
    public void CloseOpen()
    {
        secSnap = (long[])secAt.Clone(); secTracks = new Dictionary<string, float[]>();
        foreach (var kv in tracks) if (kv.Value.Sec.Any(x => !float.IsNaN(x))) secTracks[kv.Key] = (float[])kv.Value.Sec.Clone();
        openAcc = new Dictionary<string, double[]>(); openMin = curMin; openTen = curTen;
        foreach (var kv in tracks) { var t = kv.Value; if (t.MCnt > 0 || t.TCnt > 0) openAcc[kv.Key] = new[] { t.MCnt, t.MSum, t.MPeak, t.TCnt, t.TSum, t.TPeak }; }
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
        if (!File.Exists(path)) return;
        FileStream fs;
        try { fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read); }
        catch { if (++tries < 10) { held = true; retryAt = Source.Unix() + 60; } else SetAside(); return; }
        try
        {
            long now = Source.Unix(); int nowMin = (int)(now / 60), nowTen = (int)(now / 600);
            using (var r = new BinaryReader(fs))
            {
                if (r.ReadInt32() != 0x4B444857 || r.ReadInt32() != 2) throw new InvalidDataException("not a history file");
                int n = r.ReadInt32();
                for (int i = 0; i < n; i++)
                {
                    string key = r.ReadString();
                    Track t; if (!tracks.TryGetValue(key, out t)) t = new Track();   // a later try adds to what this run measured
                    bool any = false;
                    int c = r.ReadInt32();
                    for (int j = 0; j < c; j++)
                    {
                        int at = r.ReadInt32(); float a = r.ReadSingle(), m = r.ReadSingle();
                        if (at > nowMin - MinLen && at <= nowMin) { int k = at % MinLen; if (minAt[k] != at || float.IsNaN(t.MAvg[k])) { t.MAvg[k] = a; t.MMax[k] = m; } minAt[k] = at; any = true; }
                    }
                    c = r.ReadInt32();
                    for (int j = 0; j < c; j++)
                    {
                        int at = r.ReadInt32(); float a = r.ReadSingle(), m = r.ReadSingle();
                        if (at > nowTen - TenLen && at <= nowTen) { int k = at % TenLen; if (tenAt[k] != at || float.IsNaN(t.TAvg[k])) { t.TAvg[k] = a; t.TMax[k] = m; } tenAt[k] = at; any = true; }
                    }
                    if (any) tracks[key] = t;
                }
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
        // a build's always-on lines (x:) step aside while a cell's lines watch the same reading the same way: the cell
        // says it once (its lines are the ones you set); without such a cell, or with lines that can't judge (no
        // yellow, red on the wrong side), they come back. A build's judged rules (Own, below) always stay: they
        // say something no line can
        Func<Rule, bool> judges = x => (x.Mode == "y" || x.Mode == "yr") && !double.IsNaN(x.Y) && !(x.Mode == "yr" && !double.IsNaN(x.R) && (x.Dir == "below" ? x.R >= x.Y : x.R <= x.Y));
        var watched = new HashSet<string>(list.Where(x => !x.Id.StartsWith("x:") && judges(x)).Select(x => x.Key + "|" + x.Dir));
        list.RemoveAll(x => x.Id.StartsWith("x:") && watched.Contains(x.Key + "|" + x.Dir));
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
                if (exp > 0 && Math.Abs((v - exp) / exp * 100) > r.Tol)
                {
                    raw = 1; hold = r.CurveHold; off = true; under = v < exp; dev = Math.Abs((v - exp) / exp);
                    extra = " (" + Math.Abs(Math.Round((v - exp) / exp * 100)).ToString(System.Globalization.CultureInfo.InvariantCulture) + "% " + (v < exp ? "under" : "over") + " its curve)";
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
    readonly Dictionary<int, string> paths = new Dictionary<int, string>();
    HashSet<int> hotPids = new HashSet<int>();   // the last look's processes in a game folder
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
            if (roots == null || (DateTime.Now - rootsAt).TotalMinutes > 10)
            {
                bool first = roots == null;
                roots = GameRoots.Build(); rootsAt = DateTime.Now;
                if (first) log("game folders: " + roots.Count);
            }
            if (++pollNo % 20 == 0) paths.Clear();   // pids get reused: re-resolve every minute
            var devices = Procs.Devices();
            int fg = Procs.Foreground();
            var alive = new HashSet<int>(); var inRoot = new HashSet<int>();
            foreach (var p in Process.GetProcesses())
            {
                int pid = p.Id; p.Dispose(); alive.Add(pid);
                string path;
                // (a pid freed and given to a new process between two looks stays alive in the cache: the window in
                // front and anything in a game folder are looked up again every time)
                if (!paths.TryGetValue(pid, out path) || pid == fg || hotPids.Contains(pid)) { path = Procs.ImagePath(pid, devices); paths[pid] = path; }
                if (path == null) continue;
                string lp = path.ToLowerInvariant(), name = null;
                foreach (var r in roots) if (lp.StartsWith(r.Key)) { name = r.Value; break; }
                if (name == null) continue;
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
    // this session's min, average and max of each of the game's own readings, for the page (null: no session)
    public Dictionary<string, object> SessionPm()
    {
        if (!polled || rep == null || rep.Pm == null) return null;   // (before the first look: still the last run's)
        return rep.Pm.Where(kv => kv.Value != null && kv.Value.Length == 4 && kv.Value[2] > 0)
                     .ToDictionary(kv => kv.Key, kv => (object)new object[] { Fin(kv.Value[0], 2), Fin(kv.Value[1] / kv.Value[2], 2), Fin(kv.Value[3], 2) });
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
        if (pending.Count > 0) WritePending();
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
        if (src.Status != "ok") return;
        foreach (var kv in gated) rep.Ln[kv.Key] = kv.Value;
        Pick(src);
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
        Func<int, double> at = i => i >= 0 && i < src.Values.Length && src.Values[i] > 0 ? src.Values[i] : double.NaN;
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
    void DropLine(string line)
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
        var line = json.Serialize(Line(r, end));
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
                                                 { "g", r.G }, { "c", r.C }, { "f", r.F }, { "wl", wl }, { "tf", Fin(r.Tf) }, { "tl", Fin(r.Tl) }, { "tb", r.Tb }, { "tc", r.Tc }, { "p", 3 } };   // p: the decimals its items keep
        if (r.Custom == 1) d["custom"] = 1;
        if (r.Gaps.Count > 0) d["gaps"] = r.Gaps;
        return d;
    }
    // session lines not in games.log yet (a write that failed is tried again every second and at exit, not dropped)
    readonly List<string> pending = new List<string>();
    void WritePending()
    {
        // (one line per session, judged by games.log as it is now: a line it already has as long or longer isn't added,
        // an earlier, shorter one of the same session comes out; Write judged it too, maybe while the log couldn't be read)
        var have = LogLines(); var blocked = new List<string>();
        if (have != null)
        {
            var keys = have.Select(l => new { l, k = l.IndexOf("\"start\":", StringComparison.Ordinal) >= 0 ? Key(l) : null }).Where(x => x.k != null).ToList();
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
        if (pending.Count == 0) { PendDone(); return; }
        if (go.Count == 0) { try { Disk.SwapLines(PendFile(), pending); } catch { } return; }
        try { Disk.AppendLines(logPath, go); LogChanged = true; foreach (var l in go) pending.Remove(l); if (pending.Count == 0) PendDone(); else { try { Disk.SwapLines(PendFile(), pending); } catch { } } }
        catch (Exception ex)
        {
            if (pending.Count == 1) log("game report write failed (tried again): " + ex.Message);
            try { Disk.SwapLines(PendFile(), pending); } catch { }   // (on disk meanwhile: a quit or a crash before it goes in loses nothing)
        }
    }
    // games.log.pending, or .pending.2 while the first is held unread (never written over before it is read)
    readonly List<string> pendHeld = new List<string>(), pendDrop = new List<string>();   // pendDrop: held ones cleared meanwhile
    string PendFile() { return pendHeld.Contains(pendPath) ? pendPath + ".2" : pendPath; }
    void PendDone() { foreach (var f in new[] { pendPath, pendPath + ".2" }) if (!pendHeld.Contains(f) && File.Exists(f)) { try { File.Delete(f); } catch { } } }
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
    public int EditLog(Func<Dictionary<string, object>, int> f, Func<string, bool> maybe = null, bool once = false)
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
        if (gone.Count > 0) { Disk.AppendLines(logPath + ".bak", gone); DeckForm.Shorten(logPath + ".bak", 8 << 20); }   // (first: a failed swap leaves a copy twice, never none)
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
        TrimAlerts(); TrimGames();   // (the start's trims ran on unknown days: nothing cut then)
        if (src.Frames != null && FpsWanted && !Brand.NoActions) Try(() => src.Frames.Start());
        if (pageReady) SendSettings();
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
    long lastSecond, lastSave = Source.Unix(), lastHwPath;
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
        if (NoFocus) focusAtStart = GetForegroundWindow();
        src = new DeckSource(fake ? (Source)new FakeSource(fakeN) : new HwSource());
        alerts.Conn = src.Conn;
        hist = new History(dataDir);
        games = new Games(dataDir, Log);
        runName = custom ? Brand.Name + " (" + Path.GetFileName(data) + " " + ((uint)data.ToLowerInvariant().Aggregate(2166136261u, (h, ch) => (h ^ ch) * 16777619u)).ToString("x8") + ")" : Brand.Name;
        settings = ReadSettings();
        games.MergeWithin = MergeMins() * 60;
        // the game's own frames (Settings: Accurate game fps): on when it was turned on and Windows lets this account trace
        // (trace names are for the whole PC: the account's own id in it, so two accounts signed in at once don't stop each other's)
        if (!fake) { src.Frames = new Frames(runName + " frames " + System.Security.Principal.WindowsIdentity.GetCurrent().User.Value); if (FpsWanted && !Brand.NoActions) src.Frames.Start(); }   // (a test copy never takes over the trace)
        // (a session over 10 minutes quiet, the PC asleep, is about to end: not its length with the sleep in it)
        // (the game gone, in its grace: held at its last counted second, as the session is)
        src.GameMin = () => { string g = games.Game; long since = games.Since, last = games.LastFed, seen = games.Seen, now = Source.Unix(); bool grace = last > 0 && now - seen > 6; return g != null && since > 0 && !(last > 0 && now - last > 600) ? Math.Max(0, (grace ? last : now) - since - games.GapSecs) / 60.0 : double.NaN; };   // (its breaks aren't play)
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
        RestoreWin();
        ResizeBegin += delegate { moving = true; };
        ResizeEnd += delegate { moving = false; if (fitAfterMove) { fitAfterMove = false; FitToScreen(); } SaveWin(); };
        Resize += delegate { if (WindowState != FormWindowState.Minimized) { restoreMax = WindowState == FormWindowState.Maximized; PostMax(); } };
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
        Log("start " + AppInfo.Version + " (pid " + Process.GetCurrentProcess().Id + (fake ? ", fake " + fakeN : "") + ", data " + dataDir + ")");
    }

    long savedAt;
    bool ended;
    void SaveAll() { try { ExtStop(); } catch { } Try(() => { if (src.Frames != null) src.Frames.Stop(); }); if (settingsRetry) SaveSettings(); SaveData(); EndMark(); }   // (a trace left running stays until Windows restarts)
    bool FpsWanted { get { return settings.ContainsKey("gameFps") && true.Equals(settings["gameFps"]); } }

    // ---- extras: a build may add readings (Extra), cell kinds (web\extras.js) and messages of its own ("x.*" both
    // ways); HW Deck itself has none, so these calls compile away ----
    partial void ExtStart();                                            // the end of the constructor: add to src.Extras
    partial void ExtMessage(string t, Dictionary<string, object> m);    // a message from the page whose type starts "x."
    partial void ExtSecond(long now);                                   // once a second, after the history sample
    partial void ExtStop();                                             // quitting or the session ending: save what it keeps
    void SaveData()
    {
        long ago = Source.Unix() - savedAt;
        if (ago >= 0 && ago < 5) return;   // the window closing and the app exiting both ask (the clock set back since: saved)
        savedAt = Source.Unix();
        hist.CloseOpen(); hist.Save(true); hist.DropOpen(); games.Flush();
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
                case "ready": pageReady = true; sentVersion = -1; subCells.Clear(); subRows.Clear(); SendState(); PostMax(); force = true; OnTick(null, null); break;
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
                            if (f != "state" || !stateFailing) { Log("saving " + f + " failed: " + ex.Message); var r = Msg("toast"); r["text"] = "Couldn't save the layout: " + ex.Message + (f == "state" ? " Trying again." : ""); Post(r); }
                            if (f == "state") { stateFailing = true; stateRetryAt = Source.Unix() + 5; }
                        }
                        // (a slot another program held when the page started isn't saved over: said so; the view's start toast says it for state)
                        if (!saved && f != "state" && heldFiles.Contains(f.Replace('/', '\\'))) { var r = Msg("toast"); r["text"] = "Couldn't save to that slot: another program has its file open. Try again in a moment."; Post(r); }
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
                case "alerts": SendLog("alerts.log", "alerts"); break;
                case "alerts:clear": Wipe("alerts.log"); SendCleared("alerts"); break;
                case "games": SendLog("games.log", "games"); break;
                case "gamesLive": gamesLive = true.Equals(m["on"]); if (gamesLive) PostLive(); break;   // the sessions popup opened or closed
                case "games:clear": Wipe("games.log"); games.Forget(); SendCleared("games"); break;
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
                    if (m.ContainsKey("games")) settings["gameDays"] = Days(m["games"]);
                    if (m.ContainsKey("warns")) settings["warnDays"] = Days(m["warns"]);
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
                case "openData": Process.Start("explorer.exe", "\"" + dataDir + "\""); break;
                case "updates": settings["updates"] = true.Equals(m["on"]); updNext = 0; SaveSettings(); SendSettings(); break;
                case "openRelease": OpenRelease(); break;
                case "updateNow": UpdateNow(); break;
                case "drag": Win("drag"); break;
                case "export": Export(m["data"], m["name"] as string); break;
                case "import": Import(Convert.ToInt32(m["slot"])); break;
                case "win": Win(m["a"] as string); break;
                case "exit": exiting = true; tray.Visible = false; Application.Exit(); break;   // a clean quit (tests): history and logs get saved
                // tests, made-up data only: a game in place of the processes, a reading held at a value
                case "fakeGame": if (fake) games.Pretend(m.ContainsKey("game") ? m["game"] as string : null, m.ContainsKey("front") && true.Equals(m["front"])); break;
                case "fakePin": if (fake) ((FakeSource)src.Inner).Pin(m["key"] as string, m["v"] == null ? double.NaN : Convert.ToDouble(m["v"], System.Globalization.CultureInfo.InvariantCulture)); break;
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
    volatile bool settingsRetry;
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
        r["state"] = st; r["slots"] = slots; r["fake"] = fake; r["dataDir"] = dataDir; r["version"] = AppInfo.Version; r["pc"] = Environment.MachineName;
        r["nonClient"] = nonClient;
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
        r["fps"] = FpsWanted; r["fpsState"] = FpsState(); r["fpsBusy"] = fpsBusy; r["fpsDone"] = fpsDone;
        r["updates"] = UpdatesOn();
        r["gameDays"] = DaysSet("gameDays") ? KeepDays("gameDays") : (object)null; r["warnDays"] = DaysSet("warnDays") ? KeepDays("warnDays") : (object)null;   // (null: not set, nothing cut)
        r["gameMerge"] = MergeMins();
        string latest = settings.ContainsKey("updLatest") ? settings["updLatest"] as string : null;
        r["latest"] = UpdatesOn() && Newer(latest, AppInfo.Version) ? latest : null;
        r["canUpdate"] = Installed() != null;   // (installed with the msi: its Update button installs the new one)
        Post(r);
    }

    // ---- new version check: as soon as the app starts, then once a day while it runs, asks GitHub for the latest
    // release; nothing else is sent. No answer (no network yet, as at sign-in): again in 2 minutes, 3 times, then hourly ----
    const string ReleasesApi = "https://api.github.com/repos/RodrigoArsenioo/hwdeck/releases/latest";
    const string ReleasesPage = "https://github.com/RodrigoArsenioo/hwdeck/releases/";
    long updNext;
    int updMissed;
    volatile bool updBusy, updLogged;
    bool UpdatesOn() { return Brand.Updates && !settingsHeld && (!settings.ContainsKey("updates") || !false.Equals(settings["updates"])); }   // (held: maybe turned off, so off)
    static int[] Ver(string s)
    {
        var m = Regex.Match(s ?? "", @"^v?(\d+)\.(\d+)\.(\d+)$");
        return m.Success ? new[] { int.Parse(m.Groups[1].Value), int.Parse(m.Groups[2].Value), int.Parse(m.Groups[3].Value) } : null;
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
        if (fake || updBusy || !UpdatesOn()) return;
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
                var req = (HttpWebRequest)WebRequest.Create(ReleasesApi);
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
                long t = Source.Unix();
                if (!answered) { updNext = t + (++updMissed <= 3 ? 120 : 3600); return; }   // offline
                updNext = t + 86400; updLogged = false; updMissed = 0;
                settings["updChecked"] = t;
                if (Ver(tag) != null)
                {
                    settings["updLatest"] = tag.TrimStart('v');
                    settings["updUrl"] = url != null && url.StartsWith(ReleasesPage, StringComparison.Ordinal) ? url : ReleasesPage + "latest";
                }
                SaveSettings();
                SendSettings();
            })));
        });
    }
    // ---- one-click update (an msi install only): the newest release's installer, checked against its SHA256SUMS.txt,
    // installed by a small script once HW Deck has quit (msiexec asks for permission, as for Program Files), then HW Deck
    // starts again. A zip copy, or anything else, gets the releases page instead ----
    bool updating;
    // the msi's install folder when this exe is the one installed there (HKLM\Software\<name>\InstallFolder), else null
    string Installed()
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
        if (fake || Brand.NoActions || Installed() == null) { OpenRelease(); return; }
        if (updating) return;
        updating = true;
        var r = Msg("toast"); r["text"] = "Downloading the new HW Deck..."; Post(r);
        System.Threading.ThreadPool.QueueUserWorkItem(delegate
        {
            string msi = null, err = null, dir = null, want = null;
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
                    want = m.Groups[1].Value;
                    msi = Path.Combine(dir, m.Groups[2].Value);
                    wc.DownloadFile(ReleasesPage + "latest/download/" + m.Groups[2].Value, msi);
                    // (an antivirus looks at a new installer as it lands and may hold it a moment: tried again for 10 s)
                    string hash = null;
                    for (int i = 0; hash == null; i++)
                        try { using (var sha = System.Security.Cryptography.SHA256.Create()) using (var fs = File.OpenRead(msi)) hash = BitConverter.ToString(sha.ComputeHash(fs)).Replace("-", ""); }
                        catch (IOException) { if (i >= 19) throw; System.Threading.Thread.Sleep(500); }
                        catch (UnauthorizedAccessException) { if (i >= 19) throw; System.Threading.Thread.Sleep(500); }
                    if (!hash.Equals(m.Groups[1].Value, StringComparison.OrdinalIgnoreCase)) throw new Exception("the download doesn't match its published checksum");
                }
            }
            catch (Exception ex) { err = ex.Message; }
            if (err != null && dir != null) try { Directory.Delete(dir, true); } catch { }   // (a partial or wrong download goes too)
            Try(() => BeginInvoke((Action)(() =>
            {
                if (err != null) { updating = false; Log("update failed: " + err); var t = Msg("toast"); t["text"] = "Couldn't update: " + err; Post(t); return; }
                // after this app quits: the installer (its own window, one Windows prompt), then HW Deck again, with this
                // copy's own arguments and the installer's result (it says so once it is up: see UpdateNote)
                // (the installer is checked once more right before it runs and held so nothing can change it until it
                // is done: the folder is the user's to write)
                string script = "$Msi = " + PsText(msi) + "; $Exe = " + PsText(Application.ExecutablePath) + "; $More = " + PsText(RestartArgs()) + "; $Want = '" + want + "'; $Pid0 = " + Process.GetCurrentProcess().Id + @"
try { Wait-Process -Id $Pid0 -Timeout 30 -ErrorAction SilentlyContinue } catch { }
$code = -1
$lk = $null
try {
  $lk = [IO.File]::Open($Msi, 'Open', 'Read', 'Read')
  $h = -join ([Security.Cryptography.SHA256]::Create().ComputeHash($lk) | ForEach-Object { $_.ToString('x2') })
  if ($h -ne $Want) { $code = -2 }
  else { $p = Start-Process msiexec.exe -ArgumentList '/i', ('""' + $Msi + '""'), '/passive', '/norestart' -PassThru; $null = $p.Handle; $p.WaitForExit(); $code = $p.ExitCode }
} catch { }
if ($lk) { $lk.Dispose() }
Remove-Item -LiteralPath (Split-Path $Msi) -Recurse -Force -ErrorAction SilentlyContinue
$a = @('--updated', $code); if ($More) { $a = @($More) + $a }
Start-Process -FilePath $Exe -ArgumentList $a";
                try
                {
                    var psi = new ProcessStartInfo(PowerShellExe, "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand " + Convert.ToBase64String(Encoding.Unicode.GetBytes(script)));
                    psi.UseShellExecute = false; psi.CreateNoWindow = true;
                    Process.Start(psi);
                    Log("update: installing " + Path.GetFileName(msi));
                    var t = Msg("toast"); t["text"] = "Installing the update: HW Deck closes and opens again"; Post(t);
                    // (a moment for the toast; still updating, so a second click does nothing). What comes next may take
                    // the front: the installer's window and its Windows prompt
                    AllowSetForegroundWindow(-1);
                    var q = new Timer { Interval = 1500 };
                    q.Tick += delegate { q.Stop(); exiting = true; tray.Visible = false; Application.Exit(); };
                    q.Start();
                }
                catch (Exception ex) { updating = false; Try(() => Directory.Delete(dir, true)); Log("update failed: " + ex.Message); var t = Msg("toast"); t["text"] = "Couldn't update: " + ex.Message; Post(t); }
            })));
        });
    }
    // started again by the update script with msiexec's exit code: what the user is told once the window is up
    [DllImport("user32.dll")] static extern bool AllowSetForegroundWindow(int pid);
    public static int UpdateResult = int.MinValue;   // (none: an ordinary start)
    static string UpdateNote()
    {
        int c = UpdateResult;
        if (c == int.MinValue) return null;
        return c == 0 ? Brand.Name + " is updated to " + AppInfo.Version : c == 3010 || c == 1641 ? Brand.Name + " is updated to " + AppInfo.Version + ". Windows needs a restart to finish it"
             : c == 1602 || c == 1625 ? "The update was cancelled, so this is still " + AppInfo.Version
             : c == 1618 ? "The update didn't install: another installation was running. Try Update now again in a minute"
             : c == -2 ? "The update didn't install: the downloaded installer changed before it could run"
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
        File.AppendAllText(p + ".bak", File.ReadAllText(p));
        File.WriteAllText(p, "");
        Shorten(p + ".bak", 8 << 20);
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
    // how long the logs keep what they have: 30 days unless Settings says otherwise (1 to 3650)
    static int Days(object o) { long d = Games.Long(o); return d == long.MinValue ? 30 : (int)Math.Max(1, Math.Min(3650, d)); }
    // the same game started again within this many minutes goes on with its session (Settings: Same game again; 0: never)
    int MergeMins() { object o; long v = settings.TryGetValue("gameMerge", out o) && o != null ? Games.Long(o) : long.MinValue; return v == long.MinValue ? 30 : (int)Math.Max(0, Math.Min(240, v)); }
    int KeepDays(string k) { return settings.ContainsKey(k) ? Days(settings[k]) : 30; }
    static int Rename(Dictionary<string, object> o, string name) { o["game"] = name; return 2; }
    // the game log: sessions that ended more than the days you keep ago go (into games.log.bak)
    static readonly Regex EndRe = new Regex("\"end\":(\\d+)");
    void TrimGames()
    {
        if (!DaysSet("gameDays")) return;
        long cut = Source.Unix() - KeepDays("gameDays") * 86400L;
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
            if (!DaysSet("warnDays")) return;
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
                Disk.AppendLines(p + ".bak", lines.Take(i)); Shorten(p + ".bak", 8 << 20);
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
    void SendSparks(IEnumerable<string> keys)
    {
        long now = Source.Unix();
        var d = new Dictionary<string, object>();
        foreach (var k in keys) d[k] = hist.Seconds(k, now);
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
            src.Second(games.Game != null && now - games.Seen <= 6);
            hist.Sample(src, Bottleneck.ShareKeys, src.Bneck.Shares);
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
            alerts.Skip = pmOk ? new HashSet<string>() : pmKeys;
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
            if (gamesLive && pageReady) { if (games.LogChanged) { games.LogChanged = false; PostLive(); SendLog("games.log", "games"); } else if (now % 5 == 0) PostLive(); }   // (the live one first: the log that comes after has it)
            else games.LogChanged = false;
            if (DateTime.Now.Date != trimDay) { trimDay = DateTime.Now.Date; TrimAlerts(); TrimGames(); }   // the days you keep, also on a PC that never restarts
            if (!fake && now - lastHwPath >= 60) { lastHwPath = now; RememberHwinfo(); }
            // (a view save another program's handle refused: the page sends its view again, with its gen; a settings save the
            // same: written again)
            if (stateRetryAt > 0 && pageReady && (Source.Unix() >= stateRetryAt || stateRetryAt - Source.Unix() > 5)) { stateRetryAt = 0; Post(Msg("saveView")); }   // (or the clock set back)
            if (settingsRetry && now % 5 == 0) SaveSettings();
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
        if (now - lastSave >= 900 || now < lastSave) { lastSave = now; hist.Save(false); }   // (the clock set back: saved now, counted from there)
        bool showing = pageReady && Visible && !IsIconic(Handle);   // (Windows' own word: a restore that skips the focus doesn't always update WindowState)
        if (showing && !wasShowing)
        {
            force = true; SendSparks(subCells);   // back from the tray or the taskbar: the page missed those seconds
            Post(Msg("shown"));                  // and measures its tiles again on screen (hidden, some came out short)
            // (one toast: the page has one, so each would replace the one before)
            var notes = new List<string>();
            if (stateBad != null) { notes.Add("Your view couldn't be read, so it starts empty. The old file is kept as " + stateBad + " in your files (Settings)."); stateBad = null; }
            if (UpdateNote() != null) { notes.Add(UpdateNote()); Log("update result: " + UpdateResult); UpdateResult = int.MinValue; }
            if (heldFiles.Contains("state")) notes.Add(HeldNote);
            notes.AddRange(goneNotes); goneNotes.Clear();
            if (notes.Count > 0) { var tn = Msg("toast"); tn["text"] = string.Join(" ", notes.Select(n => n.TrimEnd().EndsWith(".") ? n.TrimEnd() : n.TrimEnd() + ".")); tn["ms"] = notes.Count > 1 ? 20000 : 15000; Post(tn); }
        }
        wasShowing = showing;
        if (!showing || !(second || force)) return;
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
        if (src.Conn.Has) tk["c12"] = new object[] { src.Conn.Lopsided, src.Conn.Hot, Math.Round(src.Conn.Share, 1) };
        var gs = games.SessionPm(); if (gs != null) tk["gs"] = gs;
        tk["rec"] = games.Running();   // your own sessions running: [start, name]
        Post(tk);
    }

    // ---- HWiNFO: remember where it runs from, so a restart (free HWiNFO turns shared memory off after 12 h) can start it again ----
    void RememberHwinfo()
    {
        try
        {
            var devices = Procs.Devices();
            foreach (var p in Process.GetProcessesByName("HWiNFO64").Concat(Process.GetProcessesByName("HWiNFO32")))
            {
                string path = Procs.ImagePath(p.Id, devices); p.Dispose();
                if (path == null || (settings.ContainsKey("hwinfo") && path.Equals(settings["hwinfo"] as string, StringComparison.OrdinalIgnoreCase))) continue;
                settings["hwinfo"] = path; SaveSettings(); SendSettings();
                break;
            }
        }
        catch { }
    }
    // kills HWiNFO, switches its shared memory back on in its INI (the free version writes SensorsSM=0 after 12 h)
    // and starts it again. Exit codes: 0 done, 2 the INI couldn't be written, 3 no HWiNFO found. $Unattended (Keep
    // HWiNFO sharing's task, nobody at the PC): its welcome screen off and Sensors-only on, or it would wait on the
    // welcome screen and share nothing. Program Files comes from Windows (the known folder), not from the environment,
    // which the user's own settings can change, and HWiNFO only from this Windows session
    const string RestartScript = @"
$env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules')   # (as admin: Windows' own modules only, never the user's)
$ErrorActionPreference = 'Stop'
$pfs =@([Environment]::GetFolderPath('ProgramFiles'), [Environment]::GetFolderPath('ProgramFilesX86')) | Where-Object { $_ }
if (-not $Exe -or -not (Test-Path -LiteralPath $Exe)) {
  $Exe = $null
  foreach ($c in @(foreach ($d in $pfs) { ""$d\HWiNFO64\HWiNFO64.EXE"", ""$d\HWiNFO32\HWiNFO32.EXE"" })) {
    if (Test-Path -LiteralPath $c) { $Exe = $c; break }
  }
}
if (-not $Exe) { exit 3 }
try { $sig = Get-AuthenticodeSignature -LiteralPath $Exe } catch { $sig = $null }
if (-not $sig -or $sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -cnotmatch '^CN=""?REALiX, s\.r\.o\.""?,') { exit 4 }
$ses = (Get-Process -Id $PID).SessionId
Get-Process HWiNFO64, HWiNFO32 -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq $ses } | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3
$code = 0
try {
  $ini = [IO.Path]::ChangeExtension($Exe, '.INI')
  $lines = @(if (Test-Path -LiteralPath $ini) { Get-Content -LiteralPath $ini })
  $want = [ordered]@{ SensorsSM = '1' }
  if ($Unattended) { $want['ShowWelcomeAndProgress'] = '0'; $want['SensorsOnly'] = '1' }
  foreach ($k in $want.Keys) {
    $set = $k + '=' + $want[$k]
    if ($lines -match ('^' + $k + '=')) { $lines = @($lines | ForEach-Object { if ($_ -match ('^' + $k + '=')) { $set } else { $_ } }) }
    elseif ($lines | Where-Object { $_.Trim() -eq '[Settings]' }) {
      $out = New-Object System.Collections.ArrayList
      foreach ($l in $lines) { [void]$out.Add($l); if ($l.Trim() -eq '[Settings]') { [void]$out.Add($set) } }
      $lines = $out
    }
    else { $lines = @($lines) + @('[Settings]', $set) }
  }
  Set-Content -LiteralPath $ini -Value $lines -Encoding Default
} catch { $code = 2 }
try { $sig = Get-AuthenticodeSignature -LiteralPath $Exe } catch { $sig = $null }
if (-not $sig -or $sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -cnotmatch '^CN=""?REALiX, s\.r\.o\.""?,') { exit 4 }   # (again: the file could have changed meanwhile)
[void][Diagnostics.Process]::Start((New-Object Diagnostics.ProcessStartInfo $Exe))
if ($AfterStart) { & $AfterStart }
exit $code
";
    void RestartHwinfo()
    {
        var r = Msg("toast");
        if (fake) { r["text"] = "Demo data: there is no HWiNFO to restart"; Post(r); Restarted(-3); return; }
        if (Brand.NoActions) { r["text"] = "Test copy: HWiNFO isn't restarted"; Post(r); Restarted(-3); return; }
        if (restarting) { r["text"] = "HWiNFO is restarting already"; Post(r); return; }   // (the page's button keeps turning)
        try
        {
            string exe = settings.ContainsKey("hwinfo") ? settings["hwinfo"] as string : null;
            if (exe != null && (!Regex.IsMatch(Path.GetFileName(exe), @"^HWiNFO(64|32)\.exe$", RegexOptions.IgnoreCase) || !File.Exists(exe))) exe = null;
            string script = "$Exe = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('" + Convert.ToBase64String(Encoding.Unicode.GetBytes(exe ?? "")) + "'))" + RestartScript;
            var psi = new ProcessStartInfo(PowerShellExe, "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand " + Convert.ToBase64String(Encoding.Unicode.GetBytes(script)));
            psi.Verb = "runas"; psi.WindowStyle = ProcessWindowStyle.Hidden; psi.UseShellExecute = true;   // HWiNFO runs as admin: so must its restart
            var proc = Process.Start(psi);
            restarting = true;
            Log("hwinfo restart asked");
            r["text"] = "Restarting HWiNFO..."; Post(r);
            System.Threading.ThreadPool.QueueUserWorkItem(delegate
            {
                int code = -1;
                try { if (proc != null && proc.WaitForExit(60000)) code = proc.ExitCode; } catch { }
                string text = code == 0 ? "HWiNFO restarted with its shared memory on" : code == 2 ? "HWiNFO restarted, but its settings file couldn't be changed: turn on Shared Memory Support in its settings"
                            : code == 3 ? "HWiNFO wasn't found: start it once yourself, " + Brand.Name + " remembers where it is"
                            : code == 4 ? "That HWiNFO isn't signed by its maker (REALiX), so " + Brand.Name + " didn't start it as admin" : "The HWiNFO restart didn't finish";
                Log("hwinfo restart: " + code);
                Try(() => BeginInvoke((Action)(() => { restarting = false; var t = Msg("toast"); t["text"] = text; Post(t); Restarted(code); })));
            });
        }
        catch (Exception ex)
        {
            var w = ex as System.ComponentModel.Win32Exception;
            if (w != null && w.NativeErrorCode == 1223) { r["text"] = "HWiNFO restart cancelled"; Post(r); Restarted(-2); return; }   // No in the Windows prompt
            Log("hwinfo restart failed: " + ex.Message); r["text"] = "Couldn't restart HWiNFO: " + ex.Message; Post(r); Restarted(-1);
        }
    }
    // the page's restart button spins until this comes (code 0: restarted with shared memory on)
    void Restarted(int code) { var m = Msg("restarted"); m["code"] = code; Post(m); }

    // ---- Keep HWiNFO sharing: a Windows task that looks every hour and restarts HWiNFO (RestartScript) once it has run
    // 10 h 50 min, so about every 11 h and always before the free version's 12 h. It runs as admin like HWiNFO, so all
    // it runs is stored where only admins can write (HKLM\SOFTWARE\<name>\Keep, its result next to it), never a file
    // anyone could swap, and it starts through cmd.exe, which clears what the user's own environment could slip into
    // an admin PowerShell (the .NET profiler and COMPLUS_ settings) first. It only restarts an HWiNFO installed under
    // Program Files (started as admin with no prompt, a copy in a folder anyone can
    // write to could bring someone else's files along). A closed HWiNFO stays closed. Once this copy of HW Deck is gone
    // (a deleted zip folder) the task deletes itself; the msi's uninstall deletes it too (installer\HWDeck.wxs, under the
    // same name). Anything full screen in front (a game, a video) gets to finish first, until HWiNFO has run 11 h 40 min,
    // and HWiNFO's window, which takes the focus as it starts, is minimized, so the window in front gets it back. The
    // Win32 calls for that are made in memory: Add-Type would compile a file into the user's temp folder and load it
    // as admin. On and off are one Windows prompt each ----
    const int KeepVersion = 3;   // in its description: a later HW Deck can tell a task made before a change to its script
    string KeepTask { get { return runName + " - Keep HWiNFO sharing"; } }
    string KeepMark { get { return Brand.Name + ": " + Application.ExecutablePath; } }   // the end of its description: whose it is
    static bool InProgramFiles(string exe)
    {
        try
        {
            string full = Path.GetFullPath(exe);
            return new[] { Environment.SpecialFolder.ProgramFiles, Environment.SpecialFolder.ProgramFilesX86 }.Select(Environment.GetFolderPath)
                .Any(d => d != "" && full.StartsWith(d.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase));
        }
        catch { return false; }
    }
    bool keepBusy;   // the Windows prompt for the switch, or the change after it, under way
    // exit codes past RestartScript's: 5 HW Deck is gone (the task deleted), 6 that HWiNFO isn't under Program Files,
    // 7 not admin (left alone). A drive that isn't there (unplugged, not mapped for admins) deletes nothing. Notification
    // states 2, 3, 4: a full-screen app, a Direct3D game, presentation mode
    const string KeepScript = @"
$env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules')   # (as admin: Windows' own modules only, never the user's)
$ErrorActionPreference = 'Stop'
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { exit 7 }
if (-not (Test-Path -LiteralPath $App)) {
  if (-not (Test-Path -LiteralPath ([IO.Path]::GetPathRoot($App)))) { exit 0 }
  Start-Sleep -Seconds 120
  if (-not (Test-Path -LiteralPath $App)) {
    try { $f = New-Object -ComObject Schedule.Service; $f.Connect(); $f = $f.GetFolder('\'); if ($f.GetTask($Name).Definition.RegistrationInfo.Description.EndsWith(': ' + $App, [StringComparison]::OrdinalIgnoreCase)) { $f.DeleteTask($Name, 0); $r = [Microsoft.Win32.RegistryKey]::OpenBaseKey('LocalMachine', 'Registry64').OpenSubKey($Key, $true); $r.DeleteValue($Name, $false); $r.DeleteValue($Name + ' result', $false); $n = $r.ValueCount + $r.SubKeyCount; $r.Close(); if (-not $n) { [Microsoft.Win32.RegistryKey]::OpenBaseKey('LocalMachine', 'Registry64').DeleteSubKey($Key, $false) } } } catch { }
    exit 5
  }
}
$ses = (Get-Process -Id $PID).SessionId
$p = @(Get-Process HWiNFO64, HWiNFO32 -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq $ses } | Sort-Object StartTime)
if ($p.Count -eq 0) { exit 0 }
if (([DateTime]::UtcNow - $p[0].StartTime.ToUniversalTime()).TotalMinutes -lt $Min) { exit 0 }
$Exe = $p[0].Path; $ok = $false
if ($Exe) { $full = [IO.Path]::GetFullPath($Exe); foreach ($d in [Environment]::GetFolderPath('ProgramFiles'), [Environment]::GetFolderPath('ProgramFilesX86')) { if ($d -and $full.StartsWith($d.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { $ok = $true } } }
if (-not $ok) { exit 6 }
$Unattended = $true
$tb = [AppDomain]::CurrentDomain.DefineDynamicAssembly((New-Object Reflection.AssemblyName 'KeepHw'), 'Run').DefineDynamicModule('KeepHw').DefineType('KeepHw', 'Public, Class')
foreach ($f in ('user32.dll', 'GetForegroundWindow', [IntPtr], @()), ('user32.dll', 'GetWindowThreadProcessId', [UInt32], @([IntPtr], [UInt32].MakeByRefType())), ('user32.dll', 'PostMessageW', [Boolean], @([IntPtr], [UInt32], [IntPtr], [IntPtr])), ('shell32.dll', 'SHQueryUserNotificationState', [Int32], @([Int32].MakeByRefType()))) {
  $m = $tb.DefinePInvokeMethod($f[1], $f[0], 'Public, Static, PinvokeImpl', 'Standard', $f[2], [Type[]]$f[3], 'Winapi', 'Unicode'); $m.SetImplementationFlags('PreserveSig')
}
$W = $tb.CreateType()
$until = $p[0].StartTime.ToUniversalTime().AddMinutes(700)
while ([DateTime]::UtcNow -lt $until) { $q = 0; [void]$W::SHQueryUserNotificationState([ref]$q); if (2, 3, 4 -notcontains $q) { break }; Start-Sleep -Seconds 30 }
$p[0].Refresh(); if ($p[0].HasExited) { exit 0 }
$AfterStart = { for ($i = 0; $i -lt 40; $i++) { Start-Sleep -Milliseconds 500; $h = $W::GetForegroundWindow(); $q = [UInt32]0; [void]$W::GetWindowThreadProcessId($h, [ref]$q); if ((Get-Process -Id $q -ErrorAction SilentlyContinue).ProcessName -like 'HWiNFO*') { [void]$W::PostMessageW($h, 0x112, [IntPtr]0xF020, [IntPtr]::Zero); break } } }";
    static string PowerShellExe { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), @"WindowsPowerShell\v1.0\powershell.exe"); } }
    static string PsText(string s) { return "[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('" + Convert.ToBase64String(Encoding.Unicode.GetBytes(s ?? "")) + "'))"; }
    static object Com(object o, string name, System.Reflection.BindingFlags how, params object[] a) { return o.GetType().InvokeMember(name, how, null, o, a); }
    // on only when the task is there, enabled, this copy's (after a move or a fresh unzip it is the old folder's, which
    // deletes itself: turning it on here makes it this one's) and this user's (one task per PC: another account's shows off)
    bool KeepSharing()
    {
        if (fake) return false;
        object svc = null;
        var call = System.Reflection.BindingFlags.InvokeMethod; var get = System.Reflection.BindingFlags.GetProperty;
        try
        {
            svc = Activator.CreateInstance(Type.GetTypeFromProgID("Schedule.Service"));
            Com(svc, "Connect", call);
            object task = Com(Com(svc, "GetFolder", call, "\\"), "GetTask", call, KeepTask);   // (none: throws)
            object def = Com(task, "Definition", get);
            string desc = Com(Com(def, "RegistrationInfo", get), "Description", get) as string, uid = Com(Com(def, "Principal", get), "UserId", get) as string;
            var me = System.Security.Principal.WindowsIdentity.GetCurrent();
            bool mine = string.IsNullOrEmpty(uid) || uid.Equals(me.User.Value, StringComparison.OrdinalIgnoreCase) || uid.Equals(me.Name, StringComparison.OrdinalIgnoreCase)
                     || uid.Equals(Environment.UserName, StringComparison.OrdinalIgnoreCase);
            bool on = mine && true.Equals(Com(task, "Enabled", get)) && desc != null && desc.EndsWith(KeepMark, StringComparison.OrdinalIgnoreCase);
            if (on)
            {
                var v = Regex.Match(desc, @"Task version (\d+)\.");
                keepOld = !v.Success || int.Parse(v.Groups[1].Value) < KeepVersion;
                try
                {
                    using (var k = Microsoft.Win32.RegistryKey.OpenBaseKey(Microsoft.Win32.RegistryHive.LocalMachine, Microsoft.Win32.RegistryView.Registry64).OpenSubKey(KeepKey))
                    { int c; if (k != null && int.TryParse((k.GetValue(KeepTask + " result") as string) ?? "", out c)) keepLast = c; }
                }
                catch { }
                if (!AdminAccount()) keepLast = 7;   // (its hourly run stops there, and can't write that next to its script)
            }
            return on;
        }
        catch { return false; }
        finally { if (svc != null) Try(() => Marshal.ReleaseComObject(svc)); }
    }
    // the task's last result (its exit code, which it writes next to its script: Task Scheduler never sees it through
    // conhost), and a task made by an older HW Deck (its script is the old one), read with KeepSharing
    int keepLast; bool keepOld;
    string KeepKey { get { return @"SOFTWARE\" + Brand.Name + @"\Keep"; } }
    // the task is on but from an older HW Deck, or its last run couldn't restart HWiNFO: for under the switch (null: nothing)
    string KeepNote()
    {
        if (keepOld) return "Its task is from an older " + Brand.Name + ": turn this off and on once to update it.";
        string why = keepLast == 4 ? "that HWiNFO isn't signed by its maker (REALiX)" : keepLast == 6 ? "HWiNFO now runs from outside Program Files"
                   : keepLast == 7 ? "this account isn't an admin anymore" : keepLast == 2 ? "it restarted HWiNFO, but couldn't change HWiNFO's settings file" : null;
        return why == null ? null : "Last time it couldn't keep HWiNFO sharing: " + why + ".";
    }
    // the elevated script that makes the task: the hourly script into HKLM, then the task that starts it
    string KeepOnScript()
    {
        int min = 650, m;
        if (customData && int.TryParse(Environment.GetEnvironmentVariable("HWDECK_KEEP_MIN"), out m) && m >= 0) min = m;   // (tests, with their own --data: another age)
        string sid = System.Security.Principal.WindowsIdentity.GetCurrent().User.Value;
        string sys = Environment.GetFolderPath(Environment.SpecialFolder.System), x = System.Security.SecurityElement.Escape(Brand.Name);
        // what the task runs: cmd.exe (no .NET, no AutoRun) drops the profiler settings and the COMPLUS_ ones that load
        // code (another runtime, another JIT, a v2 profiler), then a short loader reads the hourly script from HKLM and
        // runs it. Named one by one: listing them all takes FOR /F, whose child cmd.exe runs the user's AutoRun (no /D),
        // as admin. No quotes inside cmd's line: conhost passes it on re-quoted, which drops every inner pair
        string loader = "$env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules')\n$k = [Microsoft.Win32.RegistryKey]::OpenBaseKey('LocalMachine', 'Registry64').OpenSubKey(" + PsText(KeepKey) +
            ")\nif (-not $k) { exit 3 }\n$s = $k.GetValue(" + PsText(KeepTask) + ")\nif (-not $s) { exit 3 }\n& ([ScriptBlock]::Create($s))";
        string args = "--headless " + Path.Combine(sys, "cmd.exe") + " /d /s /c \"set COR_ENABLE_PROFILING=&set COR_PROFILER=&set COR_PROFILER_PATH=&set COR_PROFILER_PATH_32=&set COR_PROFILER_PATH_64=" +
            "&set COMPLUS_Version=&set COMPLUS_InstallRoot=&set COMPLUS_DefaultVersion=&set COMPLUS_ProfAPI_ProfilerCompatibilitySetting=&set COMPLUS_AltJit=&set COMPLUS_AltJitName=" +
            "&set COMPLUS_AltJitNgen=&set COMPLUS_JitName=&set COMPLUS_GCName=&set APPDOMAIN_MANAGER_ASM=&set APPDOMAIN_MANAGER_TYPE=&" + PowerShellExe + " -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand " +
            Convert.ToBase64String(Encoding.Unicode.GetBytes(loader)) + "\"";
        string xml = "<Task version=\"1.2\" xmlns=\"http://schemas.microsoft.com/windows/2004/02/mit/task\">" +
            "<RegistrationInfo><Author>" + x + "</Author><Description>" + System.Security.SecurityElement.Escape("Restarts HWiNFO once it has run about 11 hours, with its shared memory on, so the free version never stops sharing. " +
                "Turn it off in " + Brand.Name + "'s Settings (Keep HWiNFO sharing). Task version " + KeepVersion + ". " + KeepMark) + "</Description></RegistrationInfo>" +
            "<Triggers><TimeTrigger><StartBoundary>" + DateTime.Now.AddMinutes(1).ToString("yyyy-MM-dd'T'HH:mm:ss", System.Globalization.CultureInfo.InvariantCulture) + "</StartBoundary><Repetition><Interval>PT1H</Interval></Repetition></TimeTrigger></Triggers>" +
            "<Principals><Principal id=\"Author\"><UserId>" + sid + "</UserId><LogonType>InteractiveToken</LogonType><RunLevel>HighestAvailable</RunLevel></Principal></Principals>" +
            "<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>" +
            "<StartWhenAvailable>true</StartWhenAvailable><IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings><ExecutionTimeLimit>PT1H</ExecutionTimeLimit>" +
            "<Priority>4</Priority></Settings>" +   // (the default, 7, would start HWiNFO below normal priority)
            // (conhost --headless: no window, where -WindowStyle Hidden still flashes one or opens Windows Terminal)
            "<Actions Context=\"Author\"><Exec><Command>" + Path.Combine(sys, "conhost.exe") + "</Command><Arguments>" + System.Security.SecurityElement.Escape(args) + "</Arguments></Exec></Actions></Task>";
        // (every exit records its code next to the script first, while the task's script is still there)
        string hourly = Regex.Replace(KeepScript + RestartScript, @"\bexit (\d+|\$code)", "Leave $1");
        return "$Name = " + PsText(KeepTask) + "; $Key = " + PsText(KeepKey) + "\n$hourly = @'\n$App = " + PsText(Application.ExecutablePath) + "; $Name = " + PsText(KeepTask) + "; $Key = " + PsText(KeepKey) + "; $Min = " + min +
            // (a run with nothing to do yet, exit 0 before the restart, keeps the last real result)
            "\nfunction Leave($c) { try { $r = [Microsoft.Win32.RegistryKey]::OpenBaseKey('LocalMachine', 'Registry64').OpenSubKey($Key, $true); if ($r -and $null -ne $r.GetValue($Name) -and ($c -ne 0 -or $Unattended)) { $r.SetValue($Name + ' result', [string]$c) } } catch { }; exit $c }" +
            hourly + "\n'@\n$xml = @'\n" + xml + "\n'@\n$Me = '" + sid + "'" + @"
$ErrorActionPreference = 'Stop'
if ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value -ne $Me) { exit 8 }
$s = New-Object -ComObject Schedule.Service; $s.Connect(); $f = $s.GetFolder('\')
" + KeepOwner + @"
$r = [Microsoft.Win32.RegistryKey]::OpenBaseKey('LocalMachine', 'Registry64').CreateSubKey($Key)
$r.SetValue($Name, $hourly); $r.DeleteValue($Name + ' result', $false); $r.Close()
[void]$f.RegisterTask($Name, $xml, 6, $null, $null, 3)
exit 0";
    }
    // one task per PC: another account's (exit 9) is neither taken over nor deleted, unless that account is gone
    const string KeepOwner = @"
try { $u = $f.GetTask($Name).Definition.Principal.UserId } catch { $u = $null }
if ($u) {
  try { $u = (New-Object Security.Principal.NTAccount $u).Translate([Security.Principal.SecurityIdentifier]).Value } catch { }
  $alive = $true; try { [void](New-Object Security.Principal.SecurityIdentifier $u).Translate([Security.Principal.NTAccount]) } catch { $alive = $false }
  if ($alive -and $u -ne $Me) { exit 9 }
}";
    const string KeepOffScript = @"
$ErrorActionPreference = 'Stop'
$s = New-Object -ComObject Schedule.Service; $s.Connect(); $f = $s.GetFolder('\')
" + KeepOwner + @"
try { $f.DeleteTask($Name, 0) } catch { }
try { $r = [Microsoft.Win32.RegistryKey]::OpenBaseKey('LocalMachine', 'Registry64').OpenSubKey($Key, $true); if ($r) { $r.DeleteValue($Name, $false); $r.DeleteValue($Name + ' result', $false); $n = $r.ValueCount + $r.SubKeyCount; $r.Close(); if (-not $n) { [Microsoft.Win32.RegistryKey]::OpenBaseKey('LocalMachine', 'Registry64').DeleteSubKey($Key, $false) } } } catch { }
try { [void]$f.GetTask($Name); exit 1 } catch { exit 0 }";
    void SetKeepSharing(bool on)
    {
        var r = Msg("toast");
        if (fake) { r["text"] = "Demo data: there is no HWiNFO to keep sharing"; Post(r); SendSettings(true); return; }
        if (Brand.NoActions) { r["text"] = "Test copy: no task is made or deleted"; Post(r); SendSettings(true); return; }
        if (keepBusy) { SendSettings(true); return; }
        string hw = settings.ContainsKey("hwinfo") ? settings["hwinfo"] as string : null;
        if (on && hw != null && !InProgramFiles(hw)) { r["text"] = "Keep HWiNFO sharing only restarts an HWiNFO installed in Program Files, and yours runs from " + Path.GetDirectoryName(hw); Post(r); SendSettings(true); return; }
        try
        {
            string script = "$env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules')\n" + (on ? KeepOnScript() : "$Name = " + PsText(KeepTask) + "; $Key = " + PsText(KeepKey) + "; $Me = '" + System.Security.Principal.WindowsIdentity.GetCurrent().User.Value + "'" + KeepOffScript);
            var psi = new ProcessStartInfo(PowerShellExe, "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand " + Convert.ToBase64String(Encoding.Unicode.GetBytes(script)));
            psi.Verb = "runas"; psi.WindowStyle = ProcessWindowStyle.Hidden; psi.UseShellExecute = true;   // a task that runs as admin takes an admin to make (or delete)
            var proc = Process.Start(psi);
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
                    var t = Msg("toast");
                    t["text"] = code == 8 ? "Keep HWiNFO sharing needs your own account to be an admin (Windows asked for another one)"
                              : code == 9 ? "Another account on this PC has Keep HWiNFO sharing on: there is one for the whole PC"
                              : code != 0 ? "Couldn't turn Keep HWiNFO sharing " + (on ? "on" : "off") + " (code " + code + ")"
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

    // ---- Accurate game fps (Frames): Windows lets admins and the Performance Log Users group trace frames. Turned
    // on, HW Deck adds this account to that group (one Windows prompt) and notes it in HKLM\Software\<name>\PerfLogUsers,
    // so turning it off (or the msi's uninstall) takes away only what HW Deck gave. A new group counts from the next
    // sign-in. An account already in the group (or HW Deck run as admin) needs no prompt ----
    const string PerfLogUsers = "S-1-5-32-559";
    bool fpsBusy;
    [DllImport("netapi32.dll", CharSet = CharSet.Unicode)] static extern int NetLocalGroupGetMembers(string server, string group, int level, out IntPtr buf, int max, out int read, out int total, IntPtr resume);
    [DllImport("netapi32.dll")] static extern int NetApiBufferFree(IntPtr buf);
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
        try
        {
            var me = System.Security.Principal.WindowsIdentity.GetCurrent().User;
            string g = new System.Security.Principal.SecurityIdentifier(PerfLogUsers).Translate(typeof(System.Security.Principal.NTAccount)).Value;
            g = g.Substring(g.IndexOf('\\') + 1);
            IntPtr buf; int read, total;
            if (NetLocalGroupGetMembers(null, g, 0, out buf, -1, out read, out total, IntPtr.Zero) != 0) return false;
            try
            {
                for (int i = 0; i < read; i++)
                    if (new System.Security.Principal.SecurityIdentifier(Marshal.ReadIntPtr(buf, i * IntPtr.Size)).Equals(me)) return true;
            }
            finally { NetApiBufferFree(buf); }
        }
        catch { }
        return false;
    }
    bool PerfLogUsersByUs()
    {
        try
        {
            using (var k = Microsoft.Win32.RegistryKey.OpenBaseKey(Microsoft.Win32.RegistryHive.LocalMachine, Microsoft.Win32.RegistryView.Registry64).OpenSubKey(@"Software\" + Brand.Name))
                return k != null && ((k.GetValue("PerfLogUsers") as string) ?? "").Split(';').Contains(System.Security.Principal.WindowsIdentity.GetCurrent().User.Value);
        }
        catch { return false; }
    }
    // for the page: on (counting) | signin (allowed from the next sign-in) | denied | failed | off (not wanted)
    string FpsState()
    {
        if (src.Frames == null || !FpsWanted) return "off";
        if (src.Frames.On) return "on";
        return src.Frames.State == "denied" ? (InPerfLogUsers() ? "signin" : "denied") : "failed";
    }
    // adds the account to the group (on) or takes it out if HW Deck put it there (off); exit 0 done, 3 nothing to do
    const string FpsAddScript = @"
$env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules')
$ErrorActionPreference = 'Stop'
try { Add-LocalGroupMember -SID 'S-1-5-32-559' -Member $Sid } catch { if ($_.FullyQualifiedErrorId -like 'MemberExists*') { exit 3 } else { throw } }
$k = 'HKLM:\SOFTWARE\' + $Name
if (-not (Test-Path $k)) { New-Item $k | Out-Null }
$v = @(((Get-ItemProperty $k -ErrorAction SilentlyContinue).PerfLogUsers -split ';') | Where-Object { $_ -and $_ -ne $Sid }) + $Sid
Set-ItemProperty $k -Name PerfLogUsers -Value ($v -join ';')
exit 0";
    const string FpsRemoveScript = @"
$env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules')
$ErrorActionPreference = 'Stop'
$k = 'HKLM:\SOFTWARE\' + $Name
$v = @(((Get-ItemProperty $k -ErrorAction SilentlyContinue).PerfLogUsers -split ';') | Where-Object { $_ })
if ($v -notcontains $Sid) { exit 3 }
try { Remove-LocalGroupMember -SID 'S-1-5-32-559' -Member $Sid } catch { if ($_.FullyQualifiedErrorId -notlike 'MemberNotFound*') { throw } }
$v = @($v | Where-Object { $_ -ne $Sid })
if ($v.Count) { Set-ItemProperty $k -Name PerfLogUsers -Value ($v -join ';') } else { Remove-ItemProperty $k -Name PerfLogUsers }
exit 0";
    void SetGameFps(bool on)
    {
        var r = Msg("toast");
        if (src.Frames == null) { r["text"] = "Demo data: there is no game to count"; Post(r); SendSettings(fpsDone: true); return; }
        if (Brand.NoActions) { r["text"] = "Test copy: Accurate game fps isn't changed"; Post(r); SendSettings(fpsDone: true); return; }
        if (fpsBusy) { SendSettings(fpsDone: true); return; }
        settings["gameFps"] = on; SaveSettings();
        // (a trace that runs proves only this sign-in's token: turned off, then on again, the account is out of the group
        // and the next sign-in would be refused, so the group is what decides)
        if (on) { src.Frames.Start(); if (src.Frames.State == "failed" || InPerfLogUsers() || new System.Security.Principal.WindowsPrincipal(System.Security.Principal.WindowsIdentity.GetCurrent()).IsInRole(System.Security.Principal.WindowsBuiltInRole.Administrator)) { r["text"] = FpsText(); Post(r); SendSettings(fpsDone: true); return; } }
        else { src.Frames.Stop(); if (!PerfLogUsersByUs()) { r["text"] = "Accurate game fps is off"; Post(r); SendSettings(fpsDone: true); return; } }
        // the group: one Windows prompt
        string sid = System.Security.Principal.WindowsIdentity.GetCurrent().User.Value;
        string script = "$Sid = '" + sid + "'; $Name = " + PsText(Brand.Name) + (on ? FpsAddScript : FpsRemoveScript);
        try
        {
            var psi = new ProcessStartInfo(PowerShellExe, "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand " + Convert.ToBase64String(Encoding.Unicode.GetBytes(script)));
            psi.Verb = "runas"; psi.WindowStyle = ProcessWindowStyle.Hidden; psi.UseShellExecute = true;
            var proc = Process.Start(psi);
            fpsBusy = true;
            Log("game fps " + (on ? "on" : "off") + ": group change asked");
            System.Threading.ThreadPool.QueueUserWorkItem(delegate
            {
                int code = -1;
                try { if (proc != null && proc.WaitForExit(60000)) code = proc.ExitCode; } catch { }
                Log("game fps " + (on ? "on: " : "off: ") + code);
                Try(() => BeginInvoke((Action)(() =>
                {
                    fpsBusy = false;
                    var t = Msg("toast");
                    if (on && code != 0 && code != 3) { settings["gameFps"] = false; SaveSettings(); src.Frames.Stop(); }   // (the trace started to try it stops too)
                    t["text"] = code != 0 && code != 3 ? "Couldn't " + (on ? "allow" : "take back") + " fps counting (code " + code + ")"
                              : on ? FpsText() : "Accurate game fps is off, and the permission it needed is taken back";
                    Post(t); SendSettings(fpsDone: true);
                })));
            });
        }
        catch (Exception ex)
        {
            var w = ex as System.ComponentModel.Win32Exception;
            bool no = w != null && w.NativeErrorCode == 1223;   // No in the Windows prompt
            if (on) { settings["gameFps"] = false; SaveSettings(); src.Frames.Stop(); }
            if (!no) Log("game fps failed: " + ex.Message);
            r["text"] = no ? (on ? "Cancelled: Accurate game fps stays off" : "Accurate game fps is off; the permission stays (Windows prompt cancelled)") : "Couldn't change Accurate game fps: " + ex.Message;
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
        catch (Exception ex) { Log("autostart failed: " + ex.Message); }
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
    void Win(string a)
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
            SaveWin();
        }
        else if (a == "max") { KeepFocus(() => WindowState = WindowState == FormWindowState.Maximized ? FormWindowState.Normal : FormWindowState.Maximized); SaveWin(); }
        else if (a == "close") HideToTray();
        else if ((a == "drag" || a != null && a.StartsWith("resize:")) && NoFocus) { }   // (only a real mouse moves a window: in a test's copy they'd activate it)
        else if (a == "drag")
        {
            // a second press on the title bar within the double-click time: maximize or restore, as a caption does;
            // else Windows moves the window (a maximized one comes out of maximize as it is dragged)
            int now = Environment.TickCount; var at = Cursor.Position;
            bool dbl = dragArmed && now - lastDrag < SystemInformation.DoubleClickTime && Math.Abs(at.X - lastDragAt.X) <= SystemInformation.DoubleClickSize.Width && Math.Abs(at.Y - lastDragAt.Y) <= SystemInformation.DoubleClickSize.Height;
            dragArmed = !dbl; lastDrag = now; lastDragAt = at;
            if (dbl) Win("max");
            else if (ButtonDown()) { ReleaseCapture(); SendMessage(Handle, WM_NCLBUTTONDOWN, 2, 0); }   // (a tap's mousedown comes after the finger is up: no move loop with nothing held)
        }
        else if (a != null && a.StartsWith("resize:") && WindowState != FormWindowState.Maximized)
        {
            var map = new Dictionary<string, int> { { "l", 10 }, { "r", 11 }, { "t", 12 }, { "tl", 13 }, { "tr", 14 }, { "b", 15 }, { "bl", 16 }, { "br", 17 } };
            int ht;
            if (map.TryGetValue(a.Substring(7), out ht) && ButtonDown()) { ReleaseCapture(); SendMessage(Handle, WM_NCLBUTTONDOWN, ht, 0); }
        }
    }
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
    protected override void WndProc(ref Message m)
    {
        // Alt+F4, the taskbar's Close window: to the tray here, before WinForms notes the close as the user's (it keeps
        // that after a cancel, so a later WM_CLOSE from Task Manager or taskkill would hide it instead of quitting)
        // a WM_CLOSE gets here only from outside now (Task Manager, taskkill): a quit, so a launch meanwhile starts after it
        if (m.Msg == 0x0010 /*WM_CLOSE*/ && !exiting) exiting = true;
        if (m.Msg == 0x0112 /*WM_SYSCOMMAND*/ && ((int)m.WParam & 0xFFF0) == 0xF060 /*SC_CLOSE*/ && !exiting) { SaveWin(); HideToTray(); return; }
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
            if (pbt == 4 /*PBT_APMSUSPEND*/ && !asleep) { asleep = true; sleptAt = Environment.TickCount; alerts.Mark("PC going to sleep"); WriteAlerts(); Try(SaveData); }   // (a power cut while asleep loses nothing)
            else if (pbt == 0x12 /*PBT_APMRESUMEAUTOMATIC*/ || pbt == 7 /*PBT_APMRESUMESUSPEND*/) asleep = false;
        }
        else if (m.Msg == 0x11 /*WM_QUERYENDSESSION*/) ending = true;
        // minimized: the next tick that finds it on screen says so (shown), even after a minimize too short for any
        // tick to have seen
        else if (m.Msg == 0x05 /*WM_SIZE*/ && m.WParam.ToInt64() == 1 /*SIZE_MINIMIZED*/) wasShowing = false;
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

    // a window bigger than its screen's work area (another screen's scale, a smaller second screen, a size saved on another
    // monitor) comes back inside it, never under the taskbar
    // (a monitor change in the middle of a drag waits for the drag to end: the window still straddles both screens)
    bool moving, fitAfterMove;
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
    void SaveWin()
    {
        try
        {
            var b = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
            bool max = WindowState == FormWindowState.Maximized || (WindowState == FormWindowState.Minimized && restoreMax);   // minimized from maximized comes back maximized
            Disk.Swap(WinPath, json.Serialize(new Dictionary<string, object> { { "x", b.X }, { "y", b.Y }, { "w", b.Width }, { "h", b.Height }, { "max", max } }));   // (a cut write never empties it)
        }
        catch { }
    }
    void RestoreWin()
    {
        try
        {
            if (!File.Exists(WinPath)) return;
            var d = json.Deserialize<Dictionary<string, object>>(File.ReadAllText(WinPath));
            var r = new Rectangle(Convert.ToInt32(d["x"]), Convert.ToInt32(d["y"]), Convert.ToInt32(d["w"]), Convert.ToInt32(d["h"]));
            if (!Screen.AllScreens.Any(sc => sc.WorkingArea.IntersectsWith(r))) return;   // that monitor is gone
            minTrack = Size.Empty;   // HandleCreated sets the one for the monitor it is on
            StartPosition = FormStartPosition.Manual; Bounds = r;
            if (true.Equals(d["max"]) && !NoFocus) WindowState = FormWindowState.Maximized;   // (a maximized first show takes the focus)
        }
        catch { }
    }

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

static class Program
{
    [STAThread]
    static void Main(string[] args)
    {
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
