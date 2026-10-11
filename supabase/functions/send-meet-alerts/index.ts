// 부산 수학여행 집합 알림 푸시 서버
// · 1분마다 예약 실행(pg_cron)으로 불려서, 집합 N분 전이 된 사람에게 웹 푸시를 보내요.
// · {welcome: endpoint} 로 부르면 "알림이 켜졌어요" 확인 푸시를 1번 보내요.
// · 직접 인증: 예약 실행은 x-cron-secret 헤더가 맞아야 하고, welcome은 등록된 기기에만 고정 문구를 보냄.
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2.99.3";

const URL_ = Deno.env.get("SUPABASE_URL")!;
let KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
try { const ks = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}"); if (ks.default) KEY = ks.default; } catch (_) { /* 없으면 기본 키 */ }
const sb = createClient(URL_, KEY, { auth: { persistSession: false } });

const MIN = 60_000;
const KST = (s: string) => new Date(s.length === 16 ? `${s}:00+09:00` : s);
const hm = (d: Date) => new Date(d.getTime() + 9 * 3600_000).toISOString().slice(11, 16);
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json", ...cors } });

type Ev = { id: string; place: string; when: Date; note: string };

// 사이트의 meetEvents()와 같은 규칙: 집합 공지 + 일정별 집합 시간
function meetEvents(state: any): Ev[] {
  const evs: Ev[] = [], seen = new Set<string>();
  const add = (e: Ev) => {
    if (!e.when || isNaN(e.when.getTime())) return;
    const sig = e.when.getTime() + "|" + e.place;
    if (seen.has(sig)) return; seen.add(sig); evs.push(e);
  };
  const m = state?.meet ?? {};
  if (m.time) add({ id: "meet", place: m.place || "집합 장소", when: KST(m.time), note: m.note || "" });
  for (const d of state?.days ?? []) for (const it of d.items ?? []) {
    if (!it.meetTime) continue;
    add({ id: it.id, place: it.meetPlace || it.place, when: KST(`${d.date}T${it.meetTime}`), note: it.title || "" });
  }
  return evs;
}

async function send(sub: any, payload: object) {
  try {
    await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload), { TTL: 900, urgency: "high" });
    return "ok";
  } catch (e: any) {
    if (e?.statusCode === 404 || e?.statusCode === 410) {   // 구독이 사라진 기기 → 정리
      await sb.from("push_subs").delete().eq("endpoint", sub.endpoint);
      return "gone";
    }
    console.error("push fail", e?.statusCode, e?.body ?? String(e));
    return "fail";
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  const { data: cfg, error: cfgErr } = await sb.rpc("get_push_config");
  if (cfgErr || !cfg) { console.error("config", cfgErr); return json({ error: "config" }, 500); }
  webpush.setVapidDetails(cfg.vapid_subject, cfg.vapid_public, cfg.vapid_private);
  const body = await req.json().catch(() => ({}));

  // 알림 켰을 때 확인용 푸시 (사이트에서 호출)
  if (body.welcome) {
    const { data: sub } = await sb.from("push_subs").select("*").eq("endpoint", body.welcome).maybeSingle();
    if (!sub) return json({ ok: false }, 404);
    const r = await send(sub, { title: "🔔 집합 알림이 켜졌어요", body: `집합 ${sub.lead_min}분 전에 알려 드릴게요`, tag: "welcome" });
    return json({ ok: r === "ok", result: r });
  }

  // [임시] 테스트 푸시: delay초 뒤에 보냄 (다른 앱으로 넘어가서 확인할 수 있게)
  if (body.test) {
    const { data: sub } = await sb.from("push_subs").select("*").eq("endpoint", body.test).maybeSingle();
    if (!sub) return json({ ok: false, result: "no-sub" }, 404);
    await new Promise((r) => setTimeout(r, Math.min(20, Math.max(0, +body.delay || 0)) * 1000));
    const r = await send(sub, { title: "🧪 푸시 알림 테스트", body: "이 알림이 보이면 성공이에요!", tag: "test" });
    return json({ ok: r === "ok", result: r });
  }

  // 예약 실행(1분마다)
  if (req.headers.get("x-cron-secret") !== cfg.cron_secret) return json({ error: "unauthorized" }, 401);
  const now = Date.now();
  const { data: st } = await sb.from("trip_state").select("data").eq("id", "main").maybeSingle();
  const evs = meetEvents(st?.data);
  const { data: subs } = await sb.from("push_subs").select("*");
  const { data: sentRows } = await sb.from("push_sent").select("endpoint,key").gte("sent_at", new Date(now - 2 * 86400_000).toISOString());
  const sent = new Set((sentRows ?? []).map((r) => r.endpoint + "#" + r.key));
  let n = 0;
  for (const sub of subs ?? []) {
    for (const ev of evs) {
      const lead = sub.lead_min, t = ev.when.getTime() - lead * MIN;
      const key = `${ev.id}|${ev.when.toISOString()}|${lead}`;
      // 알림 시각이 지났고, 15분 이내이며, 집합 시간이 5분 이상 지나지 않았을 때만 (사이트와 같은 규칙)
      if (now < t || now - t >= 15 * MIN || now - ev.when.getTime() >= 5 * MIN) continue;
      if (sent.has(sub.endpoint + "#" + key)) continue;
      if (new Date(sub.updated_at).getTime() > t) continue;   // 알림 시각이 지난 뒤에 켠 사람은 이번 알림 건너뜀 (사이트와 같음)
      // 먼저 기록해서 중복 발송 방지
      const { error } = await sb.from("push_sent").insert({ endpoint: sub.endpoint, key });
      if (error) continue;
      const left = Math.round((ev.when.getTime() - now) / MIN);
      const r = await send(sub, {
        title: left > 0 ? `🚩 ${left}분 후 집합!` : "🚩 지금 집합 시간!",
        body: `${ev.place} · ${hm(ev.when)}${ev.note ? "\n" + ev.note : ""}`,
        tag: "meet-" + ev.id,
      });
      if (r === "ok") n++;
      if (r === "gone") break;
    }
  }
  return json({ subs: subs?.length ?? 0, events: evs.length, sent: n });
});
