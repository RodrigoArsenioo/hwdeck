// A pretend build with extras, for test/e2e-ext.mjs (built by run-all.ps1 into test\out\ext with test\ext\extras.js):
// its own name and no update check, a group "Test extras" with a counter (a plain number) and a switch (kind "xtest"),
// the messages "x.flip" (page to host) and "x.state" (host to page), and a file written when it quits
using System.Collections.Generic;
using System.IO;

static partial class Brand
{
    static partial void Custom() { Name = "HW Deck Ext Test"; Updates = false; }
}

class TestExtra : Extra
{
    public bool On;
    int n;
    public TestExtra()
    {
        Key = "x.test"; Name = "Test extras";
        Readings.Add(new Reading { Key = Key + "/count", Label = "Counter", Unit = "", Type = 8 });
        Readings.Add(new Reading { Key = Key + "/switch", Label = "Switch", Unit = "", Type = 8, Kind = "xtest" });
        Values = new double[] { 0, 0 };
        Version = 1;
    }
    public override void Second() { n++; Values = new double[] { n, On ? 1 : 0 }; }
}

partial class DeckForm
{
    TestExtra tx;
    int secs;
    partial void ExtStart() { tx = new TestExtra(); src.Extras.Add(tx); }
    partial void ExtMessage(string t, Dictionary<string, object> m)
    {
        if (t != "x.flip") return;
        tx.On = !tx.On;
        var r = Msg("x.state"); r["on"] = tx.On; Post(r);
    }
    partial void ExtSecond(long now) { secs++; }
    partial void ExtStop() { File.WriteAllText(P("ext-stop.txt"), "stopped after " + secs + " s"); }
}
