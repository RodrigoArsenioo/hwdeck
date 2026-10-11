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
[assembly: System.Reflection.AssemblyVersion("1.0.0.0")]
[assembly: System.Reflection.AssemblyFileVersion("1.0.0.0")]
[assembly: System.Reflection.AssemblyInformationalVersion(AppInfo.Version)]

static class AppInfo
{
    public const string Version = "1.0.0";
    // log timestamps in one fixed form whatever the PC's region (its time separator or calendar would break the page's
    // parsing), with the UTC offset so durations stay right across a summer time change
    public static string Stamp() { return DateTime.Now.ToString("yyyy-MM-dd HH:mm:sszzz", System.Globalization.CultureInfo.InvariantCulture); }
}

class Sensor { public string Key, Name; }
class Reading { public string Key, Label, Unit; public int Sensor, Type; }   // Type: HWiNFO's, 1 temp .. 8 other

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
                    Values[i] = BitConverter.ToDouble(rbuf, o + 284); Min[i] = BitConverter.ToDouble(rbuf, o + 292);
                    Max[i] = BitConverter.ToDouble(rbuf, o + 300); Avg[i] = BitConverter.ToDouble(rbuf, o + 308);
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
            if (label.Length == 0) label = Str(rbuf, o + 12, 128, Ansi);
            string unit = rSize >= 460 ? Str(rbuf, o + 444, 16, Encoding.UTF8) : Str(rbuf, o + 268, 16, Ansi);
            bool known = si >= 0 && si < sens.Count;
            string key = (known ? sens[si].Key : "unknown.0") + "/" + BitConverter.ToUInt32(rbuf, o + 8).ToString("x8");
            if (!seen.Add(key)) key += "~" + i;   // two readings with one id would share a history; keep them apart
            reads.Add(new Reading { Key = key, Label = label, Unit = unit, Sensor = known ? si : -1, Type = (int)BitConverter.ToUInt32(rbuf, o) });
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
    readonly double[] bases;
    readonly Stopwatch clock = Stopwatch.StartNew();
    readonly Random rnd = new Random(7);
    double[] sum; int n;
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
        Size(count); sum = new double[count];
        for (int i = 0; i < count; i++) { Min[i] = double.MaxValue; Max[i] = double.MinValue; }
        Version = 1;
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
            v *= 1 + (rnd.NextDouble() - 0.5) * 0.02;
            Values[i] = v; sum[i] += v; Avg[i] = sum[i] / n;
            if (v < Min[i]) Min[i] = v;
            if (v > Max[i]) Max[i] = v;
        }
        Status = "ok"; Age = 0;
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

    // once a second
    public void Sample(Source src)
    {
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
        if (minute != curMin) { foreach (var t in tracks.Values) CloseMin(t); if (curMin >= 0) minAt[curMin % MinLen] = curMin; curMin = minute; }
        if (ten != curTen) { foreach (var t in tracks.Values) CloseTen(t); if (curTen >= 0) tenAt[curTen % TenLen] = curTen; curTen = ten; }
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
        secAt[si] = now;
    }

    void CloseMin(Track t)
    {
        if (curMin >= 0) { int k = curMin % MinLen; t.MAvg[k] = t.MCnt > 0 ? (float)(t.MSum / t.MCnt) : float.NaN; t.MMax[k] = t.MCnt > 0 ? (float)t.MPeak : float.NaN; }
        t.MSum = 0; t.MCnt = 0; t.MPeak = double.MinValue;
    }
    void CloseTen(Track t)
    {
        if (curTen >= 0) { int k = curTen % TenLen; t.TAvg[k] = t.TCnt > 0 ? (float)(t.TSum / t.TCnt) : float.NaN; t.TMax[k] = t.TCnt > 0 ? (float)t.TPeak : float.NaN; }
        t.TSum = 0; t.TCnt = 0; t.TPeak = double.MinValue;
    }

    static object R(double v) { return double.IsNaN(v) || double.IsInfinity(v) ? null : (object)Math.Round(v, 3); }

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
                    if (c > 0) { avg[i] = R(week ? t.TSum / c : t.MSum / c); max[i] = R(week ? t.TPeak : t.MPeak); }
                }
                else if (b >= 0)
                {
                    int k = week ? b % TenLen : b % MinLen;
                    if ((week ? tenAt[k] : minAt[k]) == b) { avg[i] = R(week ? t.TAvg[k] : t.MAvg[k]); max[i] = R(week ? t.TMax[k] : t.MMax[k]); }
                }
            }
        }
        return new Dictionary<string, object> { { "key", key }, { "range", week ? "7d" : range }, { "step", week ? 600 : 60 }, { "span", span * (week ? 600 : 60) }, { "avg", avg }, { "max", max } };
    }

    // a copy of what is closed (cheap, on the UI thread); the writing happens on a pool thread unless the app is quitting
    class Snap { public string Key; public float[] MAvg, MMax, TAvg, TMax; }
    volatile bool saving;
    public void Save(bool wait)
    {
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
    public void CloseOpen()
    {
        secSnap = (long[])secAt.Clone(); secTracks = new Dictionary<string, float[]>();
        foreach (var kv in tracks) if (kv.Value.Sec.Any(x => !float.IsNaN(x))) secTracks[kv.Key] = (float[])kv.Value.Sec.Clone();
        openAcc = new Dictionary<string, double[]>(); openMin = curMin; openTen = curTen;
        foreach (var kv in tracks) { var t = kv.Value; if (t.MCnt > 0 || t.TCnt > 0) openAcc[kv.Key] = new[] { t.MCnt, t.MSum, t.MPeak, t.TCnt, t.TSum, t.TPeak }; }
        foreach (var t in tracks.Values) { if (t.MCnt > 0) CloseMin(t); if (t.TCnt > 0) CloseTen(t); }
        if (curMin >= 0) minAt[curMin % MinLen] = curMin;
        if (curTen >= 0) tenAt[curTen % TenLen] = curTen;
    }

    void Load()
    {
        try
        {
            if (!File.Exists(path)) return;
            long now = Source.Unix(); int nowMin = (int)(now / 60), nowTen = (int)(now / 600);
            using (var r = new BinaryReader(File.OpenRead(path)))
            {
                if (r.ReadInt32() != 0x4B444857 || r.ReadInt32() != 2) return;
                int n = r.ReadInt32();
                for (int i = 0; i < n; i++)
                {
                    string key = r.ReadString();
                    var t = new Track(); bool any = false;
                    int c = r.ReadInt32();
                    for (int j = 0; j < c; j++)
                    {
                        int at = r.ReadInt32(); float a = r.ReadSingle(), m = r.ReadSingle();
                        if (at > nowMin - MinLen && at <= nowMin) { int k = at % MinLen; t.MAvg[k] = a; t.MMax[k] = m; minAt[k] = at; any = true; }
                    }
                    c = r.ReadInt32();
                    for (int j = 0; j < c; j++)
                    {
                        int at = r.ReadInt32(); float a = r.ReadSingle(), m = r.ReadSingle();
                        if (at > nowTen - TenLen && at <= nowTen) { int k = at % TenLen; t.TAvg[k] = a; t.TMax[k] = m; tenAt[k] = at; any = true; }
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
                        if (oMin == nowMin) { t.MCnt = (int)d[0]; t.MSum = d[1]; t.MPeak = d[2]; }
                        if (oTen == nowTen) { t.TCnt = (int)d[3]; t.TSum = d[4]; t.TPeak = d[5]; }
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
        catch { }
    }
}

// the warning log: every cell with gates (or a fan curve) in the working layout is checked once a second, even
// while the window is hidden. A line when it turns yellow or red, when it escalates, and when it has been back
// to normal for 3 s (with its peak), in alerts.log, the same format as the tailored dashboard
class Alerts
{
    class Rule { public string Id, Key, Name, Unit, Mode, Dir, Src; public double Y, R, Tol, Hold, CurveHold; public int Dec; public double[][] Pts; }
    class St
    {
        public long Since; public int Logged, Calm, Dec; public double Peak, PeakDev; public string Name, Unit;
        public string PeakTxt { get { return (Fmt(Peak, Dec) + " " + Unit).Trim(); } }
    }
    List<Rule> rules = new List<Rule>();
    readonly Dictionary<string, St> state = new Dictionary<string, St>();
    public readonly List<string> Lines = new List<string>();
    public int NewAlerts;                     // counted by the game report
    public HashSet<string> Skip = new HashSet<string>();   // readings with no verdict right now (PresentMon away from the game)

    static double Num(object o, double d) { try { double v = o == null ? d : Convert.ToDouble(o, System.Globalization.CultureInfo.InvariantCulture); return double.IsInfinity(v) ? d : v; } catch { return d; } }
    static object F(IDictionary<string, object> d, string k) { object o; return d != null && d.TryGetValue(k, out o) ? o : null; }
    // the page's default decimals per unit (decFor in deck.js), so the log says what the cell showed
    public static int DecFor(string u)
    {
        u = u ?? "";
        if (u == "V") return 3; if (u == "A" || u == "x") return 2;
        if (u.IndexOf('°') >= 0 || u == "W" || u == "ms" || u == "GT/s" || u == "GB" || u == "MB/s" || u == "KB/s" || u == "GB/s") return 1;
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
        var cells = F(layout as IDictionary<string, object>, "cells") as IDictionary<string, object>;
        if (cells != null)
            foreach (var kv in cells)
            {
                var c = kv.Value as IDictionary<string, object>;
                string key = F(c, "key") as string;
                if (c == null || key == null || true.Equals(F(c, "pred"))) continue;
                var g = F(c, "gates") as IDictionary<string, object>;
                var cv = F(c, "curve") as IDictionary<string, object>;
                string mode = g != null ? F(g, "mode") as string : null;
                bool gated = mode == "y" || mode == "yr";
                if (!gated && cv == null) continue;
                var rd = src.Readings.FirstOrDefault(x => x.Key == key);
                string name = Clean(F(c, "name") as string);
                var rule = new Rule { Id = kv.Key, Key = key, Name = name.Length > 0 ? name : (rd != null ? Clean(rd.Label) : key), Unit = rd != null ? rd.Unit : "",
                                      Mode = gated ? mode : "none", Dir = g != null && "below".Equals(F(g, "dir")) ? "below" : "above",
                                      Y = gated ? Num(F(g, "y"), double.NaN) : double.NaN, R = mode == "yr" ? Num(F(g, "r"), double.NaN) : double.NaN,
                                      Hold = gated ? Math.Max(0, Math.Min(1e9, Num(F(g, "hold"), 0))) : 0 };
                rule.Dec = (int)Math.Max(0, Math.Min(3, Num(F(c, "dec"), DecFor(rule.Unit))));
                if (cv != null)
                {
                    rule.Src = F(cv, "src") as string; rule.Tol = Math.Max(1, Num(F(cv, "tol"), 15)); rule.CurveHold = Math.Max(0, Math.Min(1e9, Num(F(cv, "hold"), 10)));
                    var pts = F(cv, "pts") as System.Collections.IList;   // object[] from state.json, ArrayList from a page message
                    if (pts != null)
                        rule.Pts = pts.Cast<object>().Select(p => p as System.Collections.IList).Where(p => p != null && p.Count >= 2)
                                      .Select(p => new[] { Num(p[0], double.NaN), Num(p[1], double.NaN) }).Where(p => !double.IsNaN(p[0]) && !double.IsNaN(p[1]))
                                      .OrderBy(p => p[0]).ToArray();
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
        rules = list;
        // an episode whose line is gone (cell removed, gates off, another layout loaded) ends here, not at the next start
        foreach (var id in state.Keys.Where(k => !rules.Any(r => r.Id == k)).ToList())
        {
            var s = state[id];
            if (s.Logged > 0 && s.Name != null) Lines.Add(string.Format("{0}  OK      {1}: back to normal (line removed, peak {2})", AppInfo.Stamp(), s.Name, s.PeakTxt));
            state.Remove(id);
        }
    }

    // HWiNFO stopped sharing (or the app quits): no more verdicts, open episodes end at this line
    public void Mark(string why)
    {
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

    public void Tick(Source src, Dictionary<string, int> index)
    {
        if (src.Status != "ok") return;   // no readings, no verdicts (the host marks a longer outage)
        long now = Source.Unix();
        foreach (var r in rules)
        {
            int i;
            if (!index.TryGetValue(r.Key, out i) || i >= src.Values.Length) continue;
            double v = src.Values[i];
            if (double.IsNaN(v)) continue;
            int raw = 0; double hold = r.Hold, dev = 0; bool off = false; string extra = "";
            bool skip = Skip.Contains(r.Key);
            bool gatesOk = !skip && r.Mode != "none" && !double.IsNaN(r.Y) && !(r.Mode == "yr" && !double.IsNaN(r.R) && (r.Dir == "below" ? r.R >= r.Y : r.R <= r.Y));
            if (gatesOk)
            {
                Func<double, bool> past = x => r.Dir == "below" ? v <= x : v >= x;
                if (r.Mode == "yr" && !double.IsNaN(r.R) && past(r.R)) raw = 2; else if (past(r.Y)) raw = 1;
            }
            int si;
            if (!skip && raw == 0 && r.Pts != null && r.Pts.Length > 0 && r.Src != null && index.TryGetValue(r.Src, out si) && si < src.Values.Length && !double.IsNaN(src.Values[si]))
            {
                double exp = Interp(r.Pts, src.Values[si]);
                if (exp > 0 && Math.Abs((v - exp) / exp * 100) > r.Tol)
                {
                    raw = 1; hold = r.CurveHold; off = true; dev = Math.Abs((v - exp) / exp);
                    extra = " (" + Math.Abs(Math.Round((v - exp) / exp * 100)).ToString(System.Globalization.CultureInfo.InvariantCulture) + "% " + (v < exp ? "under" : "over") + " its curve)";
                }
            }
            St s;
            if (!state.TryGetValue(r.Id, out s)) { s = new St(); state[r.Id] = s; }
            if (raw > 0) { if (s.Since == 0) s.Since = now; } else s.Since = 0;
            int lvl = raw > 0 && now - s.Since >= hold ? raw : 0;
            if (lvl > 0)
            {
                s.Calm = 0;
                // the worst moment: furthest past the line, or furthest off the curve
                bool worse = off ? dev > s.PeakDev : r.Dir == "below" ? v < s.Peak : v > s.Peak;
                if (s.Logged == 0 || worse) { s.Peak = v; s.PeakDev = dev; s.Unit = r.Unit; s.Dec = r.Dec; }
                if (s.Logged == 0) s.Name = r.Name + (off ? " fan curve" : "");   // one name for the whole episode
                if (s.Logged != lvl && (s.Logged == 0 || lvl > s.Logged))
                {
                    Lines.Add(string.Format("{0}  {1,-7} {2}: {3} {4}{5}", AppInfo.Stamp(), lvl == 2 ? "RED" : "YELLOW", s.Name, Fmt(v, r.Dec), r.Unit, extra));
                    NewAlerts++;
                }
                if (lvl > s.Logged) s.Logged = lvl;
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
}

// where games are installed: Steam libraries (and the non-Steam shortcuts), Epic, Riot, Blizzard, EA, GOG, Ubisoft,
// Rockstar and Xbox
static class GameRoots
{
    static readonly Regex NotAGame = new Regex(@"Wallpaper.?Engine|SteamVR|OVR.?Advanced|Steamworks|Redistributable|Proton|Steam Linux Runtime|Steam Controller|Soundpad|Lossless Scaling", RegexOptions.IgnoreCase);

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
        foreach (var sys in new[] { Environment.SpecialFolder.ProgramFiles, Environment.SpecialFolder.ProgramFilesX86, Environment.SpecialFolder.Windows })
            if (n == Norm(Environment.GetFolderPath(sys))) return;   // nor a whole system folder
        roots.Add(new KeyValuePair<string, string>(n, name.Replace("\u00AE", "").Replace("\u2122", "").Trim()));
    }

    // every subkey of an HKLM key
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
                foreach (Match m in Regex.Matches(File.ReadAllText(Path.Combine(steam, @"steamapps\libraryfolders.vdf")), "\"path\"\\s+\"(.+?)\""))
                    libs.Add(m.Groups[1].Value.Replace("\\\\", "\\"));
            }
            catch { }
            foreach (var lib in libs)
            {
                try
                {
                    foreach (var acf in Directory.GetFiles(Path.Combine(lib, "steamapps"), "appmanifest_*.acf"))
                    {
                        string t = File.ReadAllText(acf);
                        var dir = Regex.Match(t, "\"installdir\"\\s+\"(.+?)\"");
                        var name = Regex.Match(t, "\"name\"\\s+\"(.+?)\"");
                        if (dir.Success && name.Success) Add(roots, Path.Combine(lib, @"steamapps\common", dir.Groups[1].Value), name.Groups[1].Value);
                    }
                    foreach (var d in Directory.GetDirectories(Path.Combine(lib, @"steamapps\common")))
                    {
                        string n = Norm(d);
                        if (n != null && !roots.Any(r => r.Key == n)) Add(roots, d, Path.GetFileName(d));
                    }
                }
                catch { }
            }
            // non-Steam games added to the library (shortcuts.vdf is binary: \x01key\x00value\x00)
            try
            {
                foreach (var f in Directory.GetFiles(Path.Combine(steam, "userdata"), "shortcuts.vdf", SearchOption.AllDirectories))
                {
                    string t = Encoding.UTF8.GetString(File.ReadAllBytes(f));
                    foreach (Match m in Regex.Matches(t, "\u0001appname\u0000([^\u0000]*)\u0000\u0001exe\u0000([^\u0000]*)\u0000\u0001startdir\u0000([^\u0000]*)\u0000", RegexOptions.IgnoreCase))
                    {
                        string start = m.Groups[3].Value.Trim().Trim('"');
                        if (start.Length <= 3) { try { start = Path.GetDirectoryName(m.Groups[2].Value.Trim().Trim('"')); } catch { start = null; } }
                        Add(roots, start, m.Groups[1].Value);
                    }
                }
            }
            catch { }
        }
        try
        {
            var ser = new JavaScriptSerializer();
            string epic = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), @"Epic\EpicGamesLauncher\Data\Manifests");
            foreach (var f in Directory.GetFiles(epic, "*.item"))
            {
                var j = ser.Deserialize<Dictionary<string, object>>(File.ReadAllText(f));
                object loc, name;
                if (j.TryGetValue("InstallLocation", out loc) && j.TryGetValue("DisplayName", out name)) Add(roots, loc as string, name as string);
            }
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
            Each(hk, e => Add(roots, e.GetValue("path") as string, e.GetValue("gameName") as string));
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
// and 1% low while it was the window in front (HWiNFO's PresentMon readings), the main temperatures, powers and
// usages, every gated cell of the layout, and how many warnings it raised
class Games
{
    class Report { public long Start, From, Last; public string Game; public int Secs, Front, FpsN, LowN, Warns; public double FpsSum, LowSum;
                   public Dictionary<string, double[]> Items = new Dictionary<string, double[]>(); public Dictionary<string, string[]> Names = new Dictionary<string, string[]>(); }
    static readonly Regex NotGameExe = new Regex(@"launcher|leagueclient|crash(report|handler|pad|sender)|report|redist|setup|^unins|helper|anticheat|battleye|beservice|prereq|bootstrap|boot(64)?$|updater|overlay|dxsetup|cefprocess|webhelper|qtwebengine|browser|diagnose|installer|config(64)?$|blizzarderror|capturepro|^upc$", RegexOptions.IgnoreCase);
    readonly object lk = new object();
    readonly Dictionary<int, string> paths = new Dictionary<int, string>();
    List<KeyValuePair<string, string>> roots; DateTime rootsAt = DateTime.MinValue;
    System.Threading.Timer timer; int busy, pollNo;
    public string Game; public bool InFront; public long Since, Seen;   // the session (30 s grace after the game closes)
    public string GameExe;                  // the exe of the game's process (the one in front if several)
    long otherSince;                        // since when another game is the one in front
    Report rep;
    readonly string logPath, curPath;
    readonly JavaScriptSerializer json = new JavaScriptSerializer();
    readonly Action<string> log;
    int headVersion = -1; List<string> head = new List<string>();
    volatile bool polled;                   // no verdicts before the first look at the processes
    string resumeGame; long resumeStart, resumeLast;   // a session the last run left open, picked up if its game still runs
    public Games(string dir, Action<string> log)
    {
        logPath = Path.Combine(dir, "games.log"); curPath = Path.Combine(dir, "games.current.json"); this.log = log;
        try { if (File.Exists(curPath)) rep = json.Deserialize<Report>(File.ReadAllText(curPath)); } catch { rep = null; }
        if (rep != null) { if (rep.Last <= 0) rep.Last = rep.Start + rep.Secs; resumeGame = rep.Game; resumeStart = rep.Start; resumeLast = rep.Last; }
        timer = new System.Threading.Timer(delegate { if (System.Threading.Interlocked.Exchange(ref busy, 1) == 1) return; try { Poll(); } catch (Exception ex) { log("games: " + ex.Message); } finally { busy = 0; } }, null, 2500, 3000);
    }
    public string LogPath { get { return logPath; } }

    void Poll()
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
        var names = new Dictionary<string, string>();   // game -> one of its exes
        string fgName = null, fgExe = null;
        var alive = new HashSet<int>();
        foreach (var p in Process.GetProcesses())
        {
            int pid = p.Id; p.Dispose(); alive.Add(pid);
            string path;
            if (!paths.TryGetValue(pid, out path)) { path = Procs.ImagePath(pid, devices); paths[pid] = path; }
            if (path == null || NotGameExe.IsMatch(Path.GetFileNameWithoutExtension(path))) continue;
            string lp = path.ToLowerInvariant(), name = null;
            foreach (var r in roots) if (lp.StartsWith(r.Key)) { name = r.Value; break; }
            if (name == null) continue;
            if (pid == fg) { fgName = name; fgExe = Path.GetFileName(path); }
            if (!names.ContainsKey(name)) names[name] = Path.GetFileName(path);
        }
        foreach (var pid in paths.Keys.Where(k => !alive.Contains(k)).ToList()) paths.Remove(pid);
        long now = Source.Unix();
        lock (lk)
        {
            // the session's game stays the game while it runs (a tool beside it doesn't split the session on every
            // alt-tab) unless another game is the one in front for 30 s
            string found;
            if (Game != null && names.ContainsKey(Game))
            {
                found = Game;
                if (fgName != null && fgName != Game) { if (otherSince == 0) otherSince = now; if (now - otherSince >= 30) found = fgName; }
                else otherSince = 0;
            }
            else { found = fgName ?? names.Keys.FirstOrDefault(); otherSince = 0; }
            InFront = found != null && found == fgName;
            GameExe = found == null ? null : found == fgName ? fgExe : names[found];
            if (found != null)
            {
                if (Game != null && (found != Game || now - Seen > 3600)) Close();
                if (Game == null) { Game = found; Since = found == resumeGame && now - resumeLast <= 600 ? resumeStart : now; }
                Seen = now;
            }
            else if (Game != null && now - Seen > 30) Close();   // 30 s grace: restarts and loading screens
            resumeGame = null;
        }
        polled = true;
    }
    void Close() { Game = null; }   // under lk; the report closes on the next Sample

    // the readings a report follows besides the gated cells: picked by their HWiNFO names
    static readonly string[][] Heads = {
        new[] { "CPU temp", "temp", @"^(CPU \(Tctl/Tdie\)|CPU Package|Core Max|CPU \(Tctl\)|CPU Die \(average\))$", "" },
        new[] { "GPU temp", "temp", @"^GPU Temperature$", "^(?!iGPU)" },
        new[] { "GPU hotspot", "temp", @"^GPU Hot ?Spot Temperature$", "^(?!iGPU)" },
        new[] { "GPU memory", "temp", @"^GPU Memory Junction Temperature$", "^(?!iGPU)" },
        new[] { "CPU power", "power", @"^CPU Package Power$", "" },
        new[] { "GPU power", "power", @"^(GPU Power|Total Board Power( \(TBP\))?|GPU ASIC Power)$", "^(?!iGPU)" },
        new[] { "GPU usage", "usage", @"^(GPU Core Load|GPU Utilization|GPU D3D Usage)$", "^(?!iGPU)" },
        new[] { "CPU usage", "usage", @"^Total CPU Usage$", "" } };
    static readonly string[] TypeNames = { "none", "temp", "volt", "fan", "current", "power", "clock", "usage", "other" };
    static readonly Regex FpsRe = new Regex(@"^Framerate( Presented)?( \(avg\))?$"), LowRe = new Regex(@"^Framerate( Presented)? \(1% low\)$");
    int fpsI = -1, lowI = -1;

    void Pick(Source src)
    {
        if (headVersion == src.Version) return;
        headVersion = src.Version; head = new List<string>(); fpsI = lowI = -1;
        foreach (var h in Heads)
        {
            var re = new Regex(h[2]); var sre = new Regex(h[3]);
            var r = src.Readings.FirstOrDefault(x => TypeNames[Math.Min(8, Math.Max(0, x.Type))] == h[1] && re.IsMatch(x.Label) && sre.IsMatch(SensorName(src, x)));
            if (r != null && !head.Contains(r.Key)) head.Add(r.Key);
        }
        for (int i = 0; i < src.Readings.Count; i++)
        {
            if (!SensorName(src, src.Readings[i]).StartsWith("PresentMon")) continue;
            if (fpsI < 0 && FpsRe.IsMatch(src.Readings[i].Label)) fpsI = i;
            if (lowI < 0 && LowRe.IsMatch(src.Readings[i].Label)) lowI = i;
        }
    }

    // once a second from the form's timer: follow the open session; write its line once it ended
    public void Sample(Source src, Dictionary<string, int> index, IEnumerable<string> gated, Alerts alerts, bool pmOk, HashSet<string> pmKeys)
    {
        if (!polled) return;
        string game; bool front; long since;
        lock (lk) { game = Game; front = InFront; since = Since; }
        if (rep != null && (game == null || rep.Start != since)) Finish();
        if (game == null) { alerts.NewAlerts = 0; return; }
        if (rep == null) { rep = new Report { Start = since, From = Source.Unix(), Game = game }; alerts.NewAlerts = 0; }
        rep.Warns += alerts.NewAlerts; alerts.NewAlerts = 0;
        rep.Last = Source.Unix();
        rep.Secs++;   // the session counts with or without HWiNFO; only its readings need it
        if (front) rep.Front++;
        if (rep.Secs % 60 == 0) { try { File.WriteAllText(curPath, json.Serialize(rep)); } catch { } }
        if (src.Status != "ok") return;
        Pick(src);
        // fps only while the game is in front and PresentMon follows it: tabbed out, it drops to its background cap
        // and PresentMon follows whatever window is in front instead
        if (front && pmOk)
        {
            if (fpsI >= 0 && fpsI < src.Values.Length && src.Values[fpsI] > 0) { rep.FpsSum += src.Values[fpsI]; rep.FpsN++; }
            if (lowI >= 0 && lowI < src.Values.Length && src.Values[lowI] > 0) { rep.LowSum += src.Values[lowI]; rep.LowN++; }
        }
        foreach (var key in head.Concat(gated).Distinct())
        {
            if (!pmOk && pmKeys.Contains(key)) continue;
            int i;
            if (!index.TryGetValue(key, out i) || i >= src.Values.Length || double.IsNaN(src.Values[i])) continue;
            double v = src.Values[i];
            double[] it;
            if (!rep.Items.TryGetValue(key, out it))
            {
                it = new[] { 0.0, 0.0, double.MinValue }; rep.Items[key] = it;
                var r = src.Readings[i];
                int hi = head.IndexOf(key);
                int hk = hi >= 0 ? Enumerable.Range(0, Heads.Length).FirstOrDefault(k => ReadingMatches(src, r, Heads[k])) : -1;
                rep.Names[key] = new[] { hk >= 0 && ReadingMatches(src, r, Heads[hk]) ? Heads[hk][0] : r.Label, r.Unit };
            }
            it[0] += v; it[1]++; if (v > it[2]) it[2] = v;
        }
    }
    static bool ReadingMatches(Source src, Reading r, string[] h)
    {
        return TypeNames[Math.Min(8, Math.Max(0, r.Type))] == h[1] && Regex.IsMatch(r.Label, h[2]) && Regex.IsMatch(SensorName(src, r), h[3]);
    }
    static string SensorName(Source src, Reading r) { return r.Sensor >= 0 && r.Sensor < src.Sensors.Count ? src.Sensors[r.Sensor].Name : ""; }

    void Finish()
    {
        var r = rep; rep = null;
        try { File.Delete(curPath); } catch { }
        if (r == null || r.Secs < 60) return;   // under a minute of play isn't a session worth a line
        // it ended when the game was last seen, or (a run that quit mid-game, a PC that slept) at its last sample
        long end = r.Last > r.Start ? r.Last : Source.Unix();
        lock (lk) if (Seen > r.Start && Seen < end) end = Seen;
        Func<double, int, object> avg = (sum, n) => n > 0 ? (object)Math.Round(sum / n) : null;
        var items = r.Items.Select(kv => (object)new object[] { r.Names[kv.Key][0], r.Names[kv.Key][1], Math.Round(kv.Value[0] / Math.Max(1, kv.Value[1]), 1), Math.Round(kv.Value[2], 1) }).ToList();
        var d = new Dictionary<string, object> { { "game", r.Game }, { "start", r.Start }, { "end", end }, { "from", r.From }, { "secs", r.Secs }, { "front", r.Front },
                                                 { "fps", avg(r.FpsSum, r.FpsN) }, { "low", avg(r.LowSum, r.LowN) }, { "items", items }, { "warns", r.Warns } };
        try { File.AppendAllText(logPath, json.Serialize(d) + "\r\n"); }
        catch (Exception ex) { log("game report write failed: " + ex.Message); }
    }
    public void Flush() { if (rep != null) { try { File.WriteAllText(curPath, json.Serialize(rep)); } catch { } } }
}

class DeckForm : Form
{
    [DllImport("user32.dll")] static extern bool ReleaseCapture();
    [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr hWnd, int msg, int wParam, int lParam);
    [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr hWnd);
    [DllImport("user32.dll")] static extern int GetSystemMetricsForDpi(int nIndex, uint dpi);
    [DllImport("user32.dll")] static extern uint GetDpiForSystem();
    const int WM_NCLBUTTONDOWN = 0xA1;
    const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";

    readonly string appDir = AppDomain.CurrentDomain.BaseDirectory, dataDir;
    readonly Source src;
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
    string stateBad;                        // a state.json that couldn't be read, kept under this name
    HashSet<string> pmKeys = new HashSet<string>(); int pmVersion = -1;
    int sentVersion = -1;
    long lastSecond, lastSave = Source.Unix(), lastHwPath;
    HashSet<string> subCells = new HashSet<string>(), subRows = new HashSet<string>(), gated = new HashSet<string>();
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
        src = fake ? (Source)new FakeSource(fakeN) : new HwSource();
        hist = new History(dataDir);
        games = new Games(dataDir, Log);
        runName = custom ? "HW Deck (" + Path.GetFileName(data) + " " + ((uint)data.ToLowerInvariant().Aggregate(2166136261u, (h, ch) => (h ^ ch) * 16777619u)).ToString("x8") + ")" : "HW Deck";
        settings = ReadFile("settings") as Dictionary<string, object> ?? new Dictionary<string, object>();
        var st = ReadFile("state", true) as Dictionary<string, object>;
        if (st != null && st.ContainsKey("L")) layout = st["L"];
        TrimAlerts();

        Text = "HW Deck";
        // sizes in logical pixels, scaled to the screen (225% on a 4K screen would otherwise make a postage stamp)
        float k = 1f;
        try { k = GetDpiForSystem() / 96f; } catch { }   // DeviceDpi still says 96 before the window exists
        var wa = Screen.PrimaryScreen.WorkingArea;
        Width = Math.Min((int)(1320 * k), (int)(wa.Width * 0.9)); Height = Math.Min((int)(840 * k), (int)(wa.Height * 0.9));
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.FromArgb(13, 13, 13);
        FormBorderStyle = FormBorderStyle.Sizable;   // native snap and maximize; the caption is drawn by the page
        MinimumSize = new Size(Math.Min((int)(720 * k), wa.Width / 2), Math.Min((int)(480 * k), wa.Height / 2));
        string icoPath = Path.Combine(appDir, "app.ico");
        try { Icon = File.Exists(icoPath) ? new Icon(icoPath) : Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }
        RestoreWin();
        ResizeEnd += delegate { SaveWin(); };
        Resize += delegate { if (WindowState != FormWindowState.Minimized) restoreMax = WindowState == FormWindowState.Maximized; };

        wv = new WebView2();
        wv.Dock = DockStyle.Fill;
        wv.DefaultBackgroundColor = Color.FromArgb(13, 13, 13);
        // the browser cache goes to LocalAppData, never next to the exe (Program Files is read-only); a run with its
        // own --data folder gets its own cache too, so a test instance can't clash with the real one
        wv.CreationProperties = new CoreWebView2CreationProperties { UserDataFolder = customData ? P("WebView2")
            : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "HW Deck", "WebView2") };
        Controls.Add(wv);
        wv.CoreWebView2InitializationCompleted += OnWvReady;
        HandleCreated += delegate
        {
            // the size limits for the monitor the window opened on (window.json may put it on another one)
            try
            {
                uint dpi = GetDpiForWindow(Handle);
                var wa2 = Screen.FromHandle(Handle).WorkingArea;
                if (dpi > 0) MinimumSize = new Size(Math.Min((int)(720 * dpi / 96), wa2.Width / 2), Math.Min((int)(480 * dpi / 96), wa2.Height / 2));
            }
            catch { }
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
        tray = new NotifyIcon { Icon = trayIcon ?? Icon ?? SystemIcons.Application, Text = "HW Deck", Visible = true };
        var menu = new ContextMenu();
        menu.MenuItems.Add("Open HW Deck", delegate { ShowWin(); });
        menu.MenuItems.Add(new MenuItem("Restart HWiNFO", delegate { RestartHwinfo(); }) { Enabled = !fake });
        autoItem = new MenuItem("Start with Windows", delegate { SetAutostart(!Autostart()); });
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
            else { tray.Visible = false; SaveAll(); }   // Windows may end the process right after this when it shuts down
        };
        Application.ApplicationExit += delegate { SaveAll(); };
        AppendLog("alerts.log", AppInfo.Stamp() + "  MARK    app start");

        timer = new Timer { Interval = 250 };
        timer.Tick += OnTick;
        timer.Start();   // history, warnings and games run from the start, page or not
        Log("start " + AppInfo.Version + " (pid " + Process.GetCurrentProcess().Id + (fake ? ", fake " + fakeN : "") + ", data " + dataDir + ")");
    }

    long savedAt;
    void SaveAll()
    {
        if (Source.Unix() - savedAt < 5) return;   // the window closing and the app exiting both ask
        savedAt = Source.Unix();
        hist.CloseOpen(); hist.Save(true); games.Flush();
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
            settings["trayHint"] = true; Try(() => SaveFile("settings", settings));
            Try(() => tray.ShowBalloonTip(6000, "HW Deck is still running", "It keeps checking your lines from here. Click the icon to open it, right-click it to exit.", ToolTipIcon.None));
        }
    }

    static bool Try(Action a) { try { a(); return true; } catch { return false; } }   // settings an older WebView2 runtime may not have
    void WebViewFailed(Exception ex)
    {
        if (wvFailed) return;
        wvFailed = true;
        Log("webview failed: " + ex);
        bool missing = ex is WebView2RuntimeNotFoundException;
        if (MessageBox.Show("HW Deck draws its window with the Microsoft Edge WebView2 Runtime, and it could not start" +
                            (missing ? ": it isn't installed on this PC." : ":\n\n" + (ex != null ? ex.Message : "unknown error")) +
                            "\n\nWindows 11 has it built in; on Windows 10 it may be missing. Open Microsoft's download page?",
                            "HW Deck", MessageBoxButtons.YesNo, MessageBoxIcon.Warning) == DialogResult.Yes)
            Try(() => Process.Start("https://go.microsoft.com/fwlink/p/?LinkId=2124703"));
        exiting = true; tray.Visible = false; Application.Exit();
    }
    void OnWvReady(object s, CoreWebView2InitializationCompletedEventArgs e)
    {
        if (!e.IsSuccess) { WebViewFailed(e.InitializationException); return; }
        var core = wv.CoreWebView2;
        // an app, not a browser: no dev tools (unless a test asked for the debug port), no browser keys (print, find,
        // reload), no autofill, no zoom, nothing dropped or clicked can take the page somewhere else
        bool debug = (Environment.GetEnvironmentVariable("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS") ?? "").Contains("remote-debugging");
        nonClient = Try(() => core.Settings.IsNonClientRegionSupportEnabled = true);   // css app-region: drag = the window caption (else the page asks for a drag)
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
            // the page's process died: load it again; the browser itself died: only a new start helps; the rest
            // (GPU, utility processes) come back by themselves
            if (ev.ProcessFailedKind == CoreWebView2ProcessFailedKind.RenderProcessExited || ev.ProcessFailedKind == CoreWebView2ProcessFailedKind.RenderProcessUnresponsive)
                Try(() => { pageReady = false; wv.CoreWebView2.Reload(); });
            else if (ev.ProcessFailedKind == CoreWebView2ProcessFailedKind.BrowserProcessExited)
                Try(() => { Process.Start(Application.ExecutablePath, RestartArgs() + " --after " + Process.GetCurrentProcess().Id + (Visible ? "" : " -min")); exiting = true; tray.Visible = false; Application.Exit(); });
        };
        core.Navigate("https://hwdeck.example/index.html");
    }

    void Post(Dictionary<string, object> m) { try { wv.CoreWebView2.PostWebMessageAsJson(json.Serialize(m)); } catch { } }
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
                case "ready": pageReady = true; sentVersion = -1; subCells.Clear(); subRows.Clear(); SendState(); force = true; OnTick(null, null); break;
                case "sub": Subscribe(m); break;
                case "save":
                    {
                        string f = m["file"] as string;
                        if (f == null || !PageFile.IsMatch(f)) break;
                        try { SaveFile(f, m["data"]); }
                        catch (Exception ex) { Log("saving " + f + " failed: " + ex.Message); var r = Msg("toast"); r["text"] = "Couldn't save the layout: " + ex.Message; Post(r); }
                        if (f == "state") { var d = m["data"] as Dictionary<string, object>; layout = d != null && d.ContainsKey("L") ? d["L"] : null; RefreshRules(); }
                    }
                    break;
                case "hist":
                    { var h = hist.Range(m["key"] as string, m["range"] as string); h["t"] = "hist"; Post(h); }
                    break;
                case "alerts": { var r = Msg("alerts"); r["log"] = Tail("alerts.log"); Post(r); } break;
                case "alerts:clear": Wipe("alerts.log"); { var r = Msg("alerts"); r["log"] = ""; Post(r); } break;
                case "games": { var r = Msg("games"); r["log"] = Tail("games.log"); Post(r); } break;
                case "games:clear": Wipe("games.log"); { var r = Msg("games"); r["log"] = ""; Post(r); } break;
                case "autostart": SetAutostart(true.Equals(m["on"])); SendSettings(); break;
                case "restartHwinfo": RestartHwinfo(); break;
                case "openData": Process.Start("explorer.exe", "\"" + dataDir + "\""); break;
                case "drag": Win("drag"); break;
                case "export": Export(m["data"], m["name"] as string); break;
                case "import": Import(Convert.ToInt32(m["slot"])); break;
                case "win": Win(m["a"] as string); break;
                case "exit": exiting = true; tray.Visible = false; Application.Exit(); break;   // a clean quit (tests): history and logs get saved
            }
        }
        catch (Exception ex) { Log("message " + t + " failed: " + ex.Message); }
    }

    // ---- files: state.json (working layout, active slot, view, edit mode) and slots\slotN.json, written whole through
    // a temp file so a crash mid-write can't leave half a layout ----
    static readonly Regex PageFile = new Regex(@"^(?:state|slots/slot[1-5])\z");   // what the page may write; settings.json is the host's alone
    void SaveFile(string name, object data)
    {
        string p = P(name.Replace('/', '\\') + ".json"), tmp = p + ".tmp";
        if (data == null) { if (File.Exists(p)) File.Delete(p); return; }
        var bytes = new UTF8Encoding(false).GetBytes(json.Serialize(data));
        using (var fs = new FileStream(tmp, FileMode.Create, FileAccess.Write, FileShare.None)) { fs.Write(bytes, 0, bytes.Length); fs.Flush(true); }   // on disk before it replaces the old one
        if (File.Exists(p)) File.Replace(tmp, p, name == "state" ? p + ".bak" : null); else File.Move(tmp, p);
    }
    // a file that can't be read is logged; the working view (keep) is moved aside instead of being overwritten by the first edit
    object ReadFile(string name, bool keep = false)
    {
        string p = P(name + ".json");
        try { return File.Exists(p) ? json.DeserializeObject(File.ReadAllText(p)) : null; }
        catch (Exception ex)
        {
            Log("reading " + name + " failed: " + ex.Message);
            if (keep)
                try { string bad = name + ".json.bad-" + DateTime.Now.ToString("yyyyMMdd-HHmmss", System.Globalization.CultureInfo.InvariantCulture); File.Move(p, P(bad)); stateBad = bad; }
                catch { }
            return null;
        }
    }
    void SendState()
    {
        var slots = new List<object>();
        for (int i = 1; i <= 5; i++) slots.Add(ReadFile("slots\\slot" + i));
        var r = Msg("state");
        r["state"] = ReadFile("state"); r["slots"] = slots; r["fake"] = fake; r["dataDir"] = dataDir; r["version"] = AppInfo.Version;
        r["nonClient"] = nonClient;
        Post(r);
        SendSettings();
    }
    void SendSettings()
    {
        var r = Msg("settings");
        r["autostart"] = Autostart(); r["hwinfo"] = settings.ContainsKey("hwinfo") ? settings["hwinfo"] : null;
        Post(r);
    }

    // the logs: the page shows the last 12 MB (the warning log keeps 7 days, see TrimAlerts); a clear keeps the old
    // log in a .bak next to it
    string Tail(string name)
    {
        string p = P(name);
        if (!File.Exists(p)) return "";
        using (var fs = new FileStream(p, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
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
    static void Shorten(string p, long max)
    {
        try
        {
            var fi = new FileInfo(p);
            if (!fi.Exists || fi.Length <= max) return;
            string s; using (var fs = new FileStream(p, FileMode.Open, FileAccess.Read)) { fs.Seek(-max, SeekOrigin.End); s = new StreamReader(fs, Encoding.UTF8).ReadToEnd(); }
            int nl = s.IndexOf('\n'); File.WriteAllText(p, nl >= 0 ? s.Substring(nl + 1) : s);
        }
        catch { }
    }
    // the warning log keeps 7 days (8, for time zones): a cell that flaps on its line can write thousands of lines a day
    void TrimAlerts()
    {
        try
        {
            string p = P("alerts.log");
            if (!File.Exists(p)) return;
            string cut = DateTime.Now.AddDays(-8).ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture);
            var lines = File.ReadAllLines(p);
            int i = 0; while (i < lines.Length && (lines[i].Length < 10 || string.CompareOrdinal(lines[i].Substring(0, 10), cut) < 0)) i++;
            if (i > 0) File.WriteAllLines(p, lines.Skip(i));
        }
        catch (Exception ex) { Log("trimming alerts.log failed: " + ex.Message); }
    }
    void AppendLog(string name, string line) { try { File.AppendAllText(P(name), line + "\r\n"); } catch { } }
    void WriteAlerts()
    {
        if (alerts.Lines.Count == 0) return;
        try { File.AppendAllLines(P("alerts.log"), alerts.Lines); alerts.Lines.Clear(); }   // cleared only once written
        catch { if (alerts.Lines.Count > 1000) alerts.Lines.RemoveRange(0, alerts.Lines.Count - 1000); }
    }
    void RefreshRules()
    {
        alerts.SetLayout(layout, src);
        // the readings of gated cells: the game report follows them too
        var set = new HashSet<string>();
        var L = layout as Dictionary<string, object>;
        object cellsObj = null;
        var cells = L != null && L.TryGetValue("cells", out cellsObj) ? cellsObj as Dictionary<string, object> : null;
        if (cells != null)
            foreach (var c in cells.Values.OfType<Dictionary<string, object>>())
            {
                object g, key, mode = null;
                var gd = c.TryGetValue("gates", out g) ? g as Dictionary<string, object> : null;
                if (gd != null) gd.TryGetValue("mode", out mode);
                if (c.TryGetValue("key", out key) && key is string && ("y".Equals(mode) || "yr".Equals(mode))) set.Add((string)key);
            }
        gated = set;
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
    DateTime trimDay = DateTime.Now.Date;
    void OnTick(object s, EventArgs e)
    {
        // whatever goes wrong in one tick goes to app.log (once a minute per kind), never to a dialog every 250 ms
        try { Tick(); }
        catch (Exception ex)
        {
            string k = ex.GetType().Name + ex.TargetSite; long at, now = Source.Unix();
            if (!logged.TryGetValue(k, out at) || now - at >= 60) { logged[k] = now; Log("tick failed: " + ex); }
        }
    }
    void Tick()
    {
        src.Poll();
        long now = Source.Unix();
        if (indexVersion != src.Version)
        {
            indexVersion = src.Version; index.Clear();
            for (int i = 0; i < src.Readings.Count; i++) index[src.Readings[i].Key] = i;
            if (layout != null) RefreshRules();
        }
        bool second = now != lastSecond;
        bool pmOk = false;
        if (second)
        {
            lastSecond = now;
            hist.Sample(src);
            // HWiNFO's PresentMon follows whatever presents frames (the desktop, a browser, this app): its fps only
            // mean something while the game is in front and PresentMon follows the game's own process
            if (pmVersion != src.Version)
            {
                pmVersion = src.Version; pmKeys = new HashSet<string>();
                foreach (var r in src.Readings) if (r.Sensor >= 0 && r.Sensor < src.Sensors.Count && src.Sensors[r.Sensor].Name.StartsWith("PresentMon")) pmKeys.Add(r.Key);
            }
            string gexe = games.GameExe;
            pmOk = games.Game != null && games.InFront && (src.PmProc == null || gexe == null || string.Equals(src.PmProc, gexe, StringComparison.OrdinalIgnoreCase));
            alerts.Skip = pmOk ? new HashSet<string>() : pmKeys;
            // HWiNFO not sharing for 10 s (the free version stops every 12 h): say so in the log and the tray, end open episodes
            if (src.Status != "ok")
            {
                if (notOkSince == 0) notOkSince = now;
                if (!paused && now - notOkSince >= 10)
                {
                    paused = true; alerts.Mark("HWiNFO stopped sharing, warnings paused");
                    tray.Text = "HW Deck: HWiNFO isn't sharing, warnings paused";
                }
            }
            else
            {
                notOkSince = 0;
                if (paused) { paused = false; alerts.Lines.Add(AppInfo.Stamp() + "  MARK    HWiNFO back, warnings on"); tray.Text = "HW Deck"; }
            }
            alerts.Tick(src, index);
            WriteAlerts();
            games.Sample(src, index, gated, alerts, pmOk, pmKeys);
            if (DateTime.Now.Date != trimDay) { trimDay = DateTime.Now.Date; TrimAlerts(); }   // a week of warnings, also for a PC that never restarts
            if (!fake && now - lastHwPath >= 60) { lastHwPath = now; RememberHwinfo(); }
        }
        if (now - lastSave >= 900) { lastSave = now; hist.Save(false); }
        bool showing = pageReady && Visible && WindowState != FormWindowState.Minimized;
        if (showing && !wasShowing)
        {
            force = true; SendSparks(subCells);   // back from the tray or the taskbar: the page missed those seconds
            if (stateBad != null) { var tb = Msg("toast"); tb["text"] = "Your view couldn't be read, so it starts empty. The old file is kept as " + stateBad + " in your files (Settings)."; tb["ms"] = 15000; Post(tb); stateBad = null; }
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
            r["readings"] = src.Readings.Select(x => (object)new object[] { x.Sensor, x.Type, x.Key, x.Label, x.Unit }).ToList();
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
        tk["i"] = ix; tk["v"] = vs; tk["mn"] = mn; tk["mx"] = mx; tk["av"] = av;
        tk["game"] = games.Game; tk["front"] = games.InFront; tk["gameSince"] = games.Since;   // plain reads of fields the game poll sets
        tk["pm"] = pmOk || !second && lastPm; lastPm = (bool)tk["pm"];
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
                settings["hwinfo"] = path; SaveFile("settings", settings); SendSettings();
                break;
            }
        }
        catch { }
    }
    // kills HWiNFO, switches its shared memory back on in its INI (the free version writes SensorsSM=0 after 12 h)
    // and starts it again. Exit codes: 0 done, 2 the INI couldn't be written, 3 no HWiNFO found
    const string RestartScript = @"
$ErrorActionPreference = 'Stop'
if (-not $Exe -or -not (Test-Path -LiteralPath $Exe)) {
  $Exe = $null
  foreach ($c in ""$env:ProgramFiles\HWiNFO64\HWiNFO64.EXE"", ""${env:ProgramFiles(x86)}\HWiNFO64\HWiNFO64.EXE"", ""$env:ProgramFiles\HWiNFO32\HWiNFO32.EXE"", ""${env:ProgramFiles(x86)}\HWiNFO32\HWiNFO32.EXE"") {
    if (Test-Path -LiteralPath $c) { $Exe = $c; break }
  }
}
if (-not $Exe) { exit 3 }
try { $sig = Get-AuthenticodeSignature -LiteralPath $Exe } catch { $sig = $null }
if (-not $sig -or $sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch 'REALiX') { exit 4 }
Get-Process HWiNFO64, HWiNFO32 -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3
$code = 0
try {
  $ini = [IO.Path]::ChangeExtension($Exe, '.INI')
  $lines = @(if (Test-Path -LiteralPath $ini) { Get-Content -LiteralPath $ini })
  if ($lines -match '^SensorsSM=') { $lines = @($lines | ForEach-Object { if ($_ -match '^SensorsSM=') { 'SensorsSM=1' } else { $_ } }) }
  elseif ($lines | Where-Object { $_.Trim() -eq '[Settings]' }) {
    $out = New-Object System.Collections.ArrayList
    foreach ($l in $lines) { [void]$out.Add($l); if ($l.Trim() -eq '[Settings]') { [void]$out.Add('SensorsSM=1') } }
    $lines = $out
  }
  else { $lines = @($lines) + @('[Settings]', 'SensorsSM=1') }
  Set-Content -LiteralPath $ini -Value $lines -Encoding Default
} catch { $code = 2 }
[void][Diagnostics.Process]::Start((New-Object Diagnostics.ProcessStartInfo $Exe))
exit $code
";
    void RestartHwinfo()
    {
        var r = Msg("toast");
        if (fake) { r["text"] = "Demo data: there is no HWiNFO to restart"; Post(r); return; }
        try
        {
            string exe = settings.ContainsKey("hwinfo") ? settings["hwinfo"] as string : null;
            if (exe != null && (exe.IndexOf('\'') >= 0 || exe.IndexOf('"') >= 0 || !Regex.IsMatch(Path.GetFileName(exe), @"^HWiNFO(64|32)\.exe$", RegexOptions.IgnoreCase) || !File.Exists(exe))) exe = null;
            string script = "$Exe = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('" + Convert.ToBase64String(Encoding.Unicode.GetBytes(exe ?? "")) + "'))" + RestartScript;
            var psi = new ProcessStartInfo("powershell.exe", "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand " + Convert.ToBase64String(Encoding.Unicode.GetBytes(script)));
            psi.Verb = "runas"; psi.WindowStyle = ProcessWindowStyle.Hidden; psi.UseShellExecute = true;   // HWiNFO runs as admin: so must its restart
            var proc = Process.Start(psi);
            Log("hwinfo restart asked");
            r["text"] = "Restarting HWiNFO..."; Post(r);
            System.Threading.ThreadPool.QueueUserWorkItem(delegate
            {
                int code = -1;
                try { if (proc != null && proc.WaitForExit(60000)) code = proc.ExitCode; } catch { }
                string text = code == 0 ? "HWiNFO restarted with its shared memory on" : code == 2 ? "HWiNFO restarted, but its settings file couldn't be changed: turn on Shared Memory Support in its settings"
                            : code == 3 ? "HWiNFO wasn't found: start it once yourself, HW Deck remembers where it is"
                            : code == 4 ? "That HWiNFO isn't signed by its maker (REALiX), so HW Deck didn't start it as admin" : "The HWiNFO restart didn't finish";
                Log("hwinfo restart: " + code);
                Try(() => BeginInvoke((Action)(() => { var t = Msg("toast"); t["text"] = text; Post(t); })));
            });
        }
        catch (Exception ex)
        {
            var w = ex as System.ComponentModel.Win32Exception;
            if (w != null && w.NativeErrorCode == 1223) { r["text"] = "HWiNFO restart cancelled"; Post(r); return; }   // No in the Windows prompt
            Log("hwinfo restart failed: " + ex.Message); r["text"] = "Couldn't restart HWiNFO: " + ex.Message; Post(r);
        }
    }

    // ---- start with Windows: a Run entry for this exe, in the tray ----
    // on only when the entry starts this copy (after a move or a fresh unzip the old entry points elsewhere)
    bool Autostart()
    {
        try
        {
            using (var k = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(RunKey))
            {
                string v = k != null ? k.GetValue(runName) as string : null;
                return v != null && v.IndexOf(Application.ExecutablePath, StringComparison.OrdinalIgnoreCase) >= 0;
            }
        }
        catch { return false; }
    }
    string RestartArgs()
    {
        // a trailing backslash before the closing quote would escape it
        return (customData ? "--data \"" + (dataDir.EndsWith("\\") ? dataDir + "\\" : dataDir) + "\"" : "") + (fake ? " --fake " + src.Readings.Count : "");
    }
    void SetAutostart(bool on)
    {
        try
        {
            using (var k = Microsoft.Win32.Registry.CurrentUser.CreateSubKey(RunKey))
            {
                if (on) k.SetValue(runName, "\"" + Application.ExecutablePath + "\" -min " + RestartArgs());
                else k.DeleteValue(runName, false);
            }
        }
        catch (Exception ex) { Log("autostart failed: " + ex.Message); }
    }

    // ---- a slot to or from a file, to move a layout to another PC ----
    void Export(object data, string name)
    {
        using (var d = new SaveFileDialog { Filter = "HW Deck layout (*.json)|*.json", FileName = (string.IsNullOrEmpty(name) ? "layout" : Regex.Replace(name, @"[\\/:*?""<>|]", "")) + ".hwdeck.json" })
        {
            if (d.ShowDialog(this) != DialogResult.OK) return;
            File.WriteAllText(d.FileName, json.Serialize(new Dictionary<string, object> { { "hwdeck", 1 }, { "slot", data } }), new UTF8Encoding(false));
            var r = Msg("toast"); r["text"] = "Exported to " + Path.GetFileName(d.FileName); Post(r);
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
                r["data"] = o != null && o.ContainsKey("slot") ? o["slot"] : null;
            }
            catch { r["data"] = null; }
            Post(r);
        }
    }

    void Win(string a)
    {
        if (a == "min") WindowState = FormWindowState.Minimized;
        else if (a == "max") { WindowState = WindowState == FormWindowState.Maximized ? FormWindowState.Normal : FormWindowState.Maximized; SaveWin(); }
        else if (a == "close") HideToTray();
        else if (a == "drag" && WindowState != FormWindowState.Maximized) { ReleaseCapture(); SendMessage(Handle, WM_NCLBUTTONDOWN, 2, 0); }
        else if (a != null && a.StartsWith("resize:") && WindowState != FormWindowState.Maximized)
        {
            var map = new Dictionary<string, int> { { "l", 10 }, { "r", 11 }, { "t", 12 }, { "tl", 13 }, { "tr", 14 }, { "b", 15 }, { "bl", 16 }, { "br", 17 } };
            int ht;
            if (map.TryGetValue(a.Substring(7), out ht)) { ReleaseCapture(); SendMessage(Handle, WM_NCLBUTTONDOWN, ht, 0); }
        }
    }

    [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int hgt, uint flags);

    // no native caption, but the resize frame stays: snapping, animations and maximize work like any window
    protected override void WndProc(ref Message m)
    {
        if (m.Msg == 0x02E0 /*WM_DPICHANGED*/)
        {
            // another monitor, another scale: take the size Windows suggests and a minimum in that monitor's pixels
            int dpi = (int)(m.WParam.ToInt64() & 0xFFFF);
            var r = (RECT)Marshal.PtrToStructure(m.LParam, typeof(RECT));
            var wa = Screen.FromRectangle(Rectangle.FromLTRB(r.L, r.T, r.R, r.B)).WorkingArea;
            MinimumSize = new Size(Math.Min(720 * dpi / 96, wa.Width / 2), Math.Min(480 * dpi / 96, wa.Height / 2));
            SetWindowPos(Handle, IntPtr.Zero, r.L, r.T, r.R - r.L, r.B - r.T, 0x0004 /*NOZORDER*/ | 0x0010 /*NOACTIVATE*/);
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
            after.T = WindowState == FormWindowState.Maximized ? before.T + frame : before.T;
            Marshal.StructureToPtr(after, m.LParam, false);
            m.Result = IntPtr.Zero;
            return;
        }
        base.WndProc(ref m);
    }

    string WinPath { get { return P("window.json"); } }
    void SaveWin()
    {
        try
        {
            var b = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
            File.WriteAllText(WinPath, json.Serialize(new Dictionary<string, object> { { "x", b.X }, { "y", b.Y }, { "w", b.Width }, { "h", b.Height }, { "max", WindowState == FormWindowState.Maximized } }));
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
            MinimumSize = Size.Empty;   // HandleCreated sets the one for the monitor it is on
            StartPosition = FormStartPosition.Manual; Bounds = r;
            if (true.Equals(d["max"])) WindowState = FormWindowState.Maximized;
        }
        catch { }
    }

    protected override void SetVisibleCore(bool value)
    {
        if (startHidden) { startHidden = false; base.SetVisibleCore(false); if (!IsHandleCreated) CreateHandle(); return; }
        base.SetVisibleCore(value);
    }

    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    public volatile bool showAsked;         // a second launch before this window existed
    public void ShowWin()
    {
        if (!IsHandleCreated) { showAsked = true; return; }
        showAsked = false;
        Try(() => wv.Visible = true);
        Show();
        if (WindowState == FormWindowState.Minimized) WindowState = restoreMax ? FormWindowState.Maximized : FormWindowState.Normal;
        Activate(); SetForegroundWindow(Handle);
    }
}

static class Program
{
    [STAThread]
    static void Main(string[] args)
    {
        string data = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "HW Deck");
        int fake = 0; bool min = false, custom = false;
        string appDir = AppDomain.CurrentDomain.BaseDirectory;
        if (new[] { @"web\index.html", @"web\deck.js", @"web\deck.css", "Microsoft.Web.WebView2.WinForms.dll", "Microsoft.Web.WebView2.Core.dll", "WebView2Loader.dll" }.Any(f => !File.Exists(Path.Combine(appDir, f))))
        {
            MessageBox.Show("HW Deck is missing some of its files. Extract the whole zip into a folder first, then start HWDeck.exe from there.", "HW Deck", MessageBoxButtons.OK, MessageBoxIcon.Warning);
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
                catch (Exception ex) { MessageBox.Show("HW Deck can't use that data folder:\n\n" + (d ?? "") + "\n" + ex.Message, "HW Deck", MessageBoxButtons.OK, MessageBoxIcon.Warning); return; }
            }
            else if (a == "--after" && i + 1 < args.Length)
            {
                int pid; if (int.TryParse(args[++i], out pid)) try { using (var old = Process.GetProcessById(pid)) old.WaitForExit(20000); } catch { }   // a restart: let the old copy finish saving
            }
            else if (a == "--fake") { fake = 300; int n; if (i + 1 < args.Length && int.TryParse(args[i + 1], out n)) { fake = Math.Max(1, Math.Min(20000, n)); i++; } }
        }
        // made-up values never go into the real history and logs: a demo without --data gets its own folder
        if (fake > 0 && !custom) data = Path.Combine(data, "demo");
        bool created;
        // one instance per data folder (a test run with --data can sit next to the real one); starting it again
        // brings the running one forward instead of doing nothing
        ulong h = 14695981039346656037UL;
        foreach (char c in data.ToLowerInvariant()) { h ^= c; h *= 1099511628211UL; }
        string id = h.ToString("x16");
        var mu = new System.Threading.Mutex(true, "HWDeck-" + id, out created);
        if (!created)
        {
            // the running copy shows its window; this launch passes on its right to bring a window to the front
            try { System.Threading.EventWaitHandle ev; if (System.Threading.EventWaitHandle.TryOpenExisting("HWDeck-show-" + id, out ev)) { AllowSetForegroundWindow(-1); ev.Set(); ev.Dispose(); } } catch { }
            return;
        }
        var show = new System.Threading.EventWaitHandle(false, System.Threading.EventResetMode.AutoReset, "HWDeck-show-" + id);
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
            MessageBox.Show("HW Deck couldn't start:\n\n" + ex.Message, "HW Deck", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }
        System.Threading.ThreadPool.RegisterWaitForSingleObject(show, delegate { if (form.IsHandleCreated) { try { form.BeginInvoke((Action)form.ShowWin); } catch { } } else form.showAsked = true; }, null, -1, false);
        Application.Run(form);
        GC.KeepAlive(mu); GC.KeepAlive(show);
    }
    [DllImport("user32.dll")] static extern bool AllowSetForegroundWindow(int pid);
    // an error nothing else caught: into app.log instead of the .NET error dialog
    static void Crash(string dir, Exception ex)
    {
        try { File.AppendAllText(Path.Combine(dir, "app.log"), AppInfo.Stamp() + "  unhandled: " + ex + "\r\n"); } catch { }
    }
}
