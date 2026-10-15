// 부산 수학여행 사이트 API
// · 입장 코드 없이 누구나 볼 수 있어요.
// · 사진 글은 누구나 수정·삭제할 수 있어요. (일정과 같은 규칙)
// · 데이터베이스 표는 브라우저에서 직접 못 건드리고(RLS), 이 함수(서비스 키)를 통해서만 읽고 써요.
// · 'eta': 그 시간대 교통을 반영한 예상 이동 시간 (카카오모빌리티 미래 운행 정보, 키는 서버 비밀값)
import { createClient } from "npm:@supabase/supabase-js@2.99.3";

const URL_ = Deno.env.get("SUPABASE_URL")!;
let KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
try { const ks = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}"); if (ks.default) KEY = ks.default; } catch (_) { /* 기본 키 사용 */ }
const sb = createClient(URL_, KEY, { auth: { persistSession: false } });

const BUCKET = "photos", SIGN_SEC = 3 * 86400, MIN = 60_000;
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const out = (o: unknown) => new Response(JSON.stringify(o), { headers: { "Content-Type": "application/json", ...cors } });
const fail = (error: string) => out({ ok: false, error });
const ID = /^[a-z0-9]{8,48}$/;
const str = (v: unknown, max: number) => String(v ?? "").slice(0, max);
const pad = (n: number) => String(n).padStart(2, "0");

async function sha(s: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}


async function sign(paths: string[]) {
  const map: Record<string, string> = {};
  for (let i = 0; i < paths.length; i += 100) {
    const { data } = await sb.storage.from(BUCKET).createSignedUrls(paths.slice(i, i + 100), SIGN_SEC);
    for (const d of data ?? []) if (d.signedUrl && d.path) map[d.path] = d.signedUrl;
  }
  return map;
}
function photoOut(r: any, urls: Record<string, string>, me: string) {
  return { id: r.id, taken_at: r.taken_at, time_src: r.time_src, place: r.place, caption: r.caption, name: r.name,
    decorated: r.decorated, from_id: r.from_id, mine: !!r.owner_hash && r.owner_hash === me,
    full: urls[r.full_path] ?? null, thumb: urls[r.thumb_path] ?? null };
}

/* ---------- 그 시간대 예상 이동 시간 ---------- */
// 일정이 이미 지났거나 먼 날이어도, '같은 요일·같은 시각'의 가장 가까운 미래 시점으로 교통 예측을 받아요.
function futureSlot(dep: string) {
  const d = new Date(`${dep}:00+09:00`);
  if (isNaN(d.getTime())) return null;
  const k = new Date(d.getTime() + 9 * 3600_000);               // KST 기준 요일·시각
  const dow = k.getUTCDay(), hh = k.getUTCHours(), mm = k.getUTCMinutes();
  const nowK = new Date(Date.now() + 9 * 3600_000 + 30 * MIN);    // 지금부터 30분 뒤 이후
  const c = new Date(Date.UTC(nowK.getUTCFullYear(), nowK.getUTCMonth(), nowK.getUTCDate(), hh, mm));
  while (c.getUTCDay() !== dow || c.getTime() < nowK.getTime()) c.setUTCDate(c.getUTCDate() + 1);
  const ref = `${c.getUTCFullYear()}${pad(c.getUTCMonth() + 1)}${pad(c.getUTCDate())}${pad(hh)}${pad(mm)}`;
  return { ref, slot: `${dow}${pad(hh)}${pad(mm)}` };
}
async function eta(legs: any[]) {
  const kakao = Deno.env.get("KAKAO_REST_API_KEY");
  if (!kakao) return { nokey: true, eta: {} };
  const want: { k: string; ck: string; a: number[]; b: number[]; ref: string }[] = [];
  for (const l of (legs ?? []).slice(0, 40)) {
    const a = (l.a ?? []).map(Number), b = (l.b ?? []).map(Number), s = futureSlot(str(l.dep, 16));
    if (a.length !== 2 || b.length !== 2 || [...a, ...b].some(isNaN) || !s) continue;
    const ck = `${a[0].toFixed(4)},${a[1].toFixed(4)}>${b[0].toFixed(4)},${b[1].toFixed(4)}@${s.slot}`;
    want.push({ k: str(l.k, 120), ck, a, b, ref: s.ref });
  }
  const res: Record<string, unknown> = {};
  const { data: cached } = await sb.from("route_eta").select("*").in("key", want.map((w) => w.ck))
    .gte("fetched_at", new Date(Date.now() - 7 * 86400_000).toISOString());
  const byKey = new Map((cached ?? []).map((c) => [c.key, c]));
  const todo = want.filter((w) => !byKey.has(w.ck));
  let i = 0;
  const worker = async () => {
    while (i < todo.length) {
      const w = todo[i++];
      try {
        const u = `https://apis-navi.kakaomobility.com/v1/future/directions?origin=${w.a[1]},${w.a[0]}&destination=${w.b[1]},${w.b[0]}&departure_time=${w.ref}&summary=true`;
        const r = await fetch(u, { headers: { Authorization: `KakaoAK ${kakao}` } });
        const j = await r.json();
        const ro = j?.routes?.[0];
        if (r.ok && ro && ro.result_code === 0 && ro.summary) {
          const row = { key: w.ck, min: Math.max(1, Math.round(ro.summary.duration / 60)), km: +(ro.summary.distance / 1000).toFixed(2), ref: w.ref, fetched_at: new Date().toISOString() };
          byKey.set(w.ck, row);
          await sb.from("route_eta").upsert(row);
        } else console.error("kakao", r.status, JSON.stringify(j).slice(0, 200));
      } catch (e) { console.error("kakao fetch", String(e)); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, todo.length) }, worker));
  for (const w of want) { const c = byKey.get(w.ck); res[w.k] = c ? { min: c.min, km: Number(c.km), ref: c.ref } : null; }
  return { nokey: false, eta: res };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  try {
    const body = await req.json().catch(() => ({}));
    const role = "member";
    const token = str(body.token, 100);
    const me = token.length >= 20 ? await sha(token) : "";

    switch (body.action) {
      case "join":
        return out({ ok: true, role });

      case "load": {
        const [{ data: st }, { data: rows }] = await Promise.all([
          sb.from("trip_state").select("data,updated_at").eq("id", "main").maybeSingle(),
          sb.from("photos").select("*").order("taken_at"),
        ]);
        const urls = await sign((rows ?? []).flatMap((r) => [r.full_path, r.thumb_path]));
        return out({ ok: true, role, state: st?.data ?? null, updated_at: st?.updated_at ?? null, photos: (rows ?? []).map((r) => photoOut(r, urls, me)) });
      }

      case "save_state": {
        const d = body.data;
        if (!d || !Array.isArray(d.days) || JSON.stringify(d).length > 200_000) return fail("bad-data");
        const ts = new Date().toISOString();
        const { error } = await sb.from("trip_state").upsert({ id: "main", data: d, updated_at: ts });
        return error ? fail("db") : out({ ok: true, updated_at: ts });
      }

      case "upload_urls": {
        if (!me) return fail("no-token");
        const id = str(body.id, 48);
        if (!ID.test(id)) return fail("bad-id");
        const r = [];
        for (const path of [`${id}.jpg`, `${id}_t.jpg`]) {
          const { data, error } = await sb.storage.from(BUCKET).createSignedUploadUrl(path);
          if (error || !data) return fail("upload-url");
          r.push({ path: data.path, token: data.token });
        }
        return out({ ok: true, uploads: r });
      }

      case "add_photo": {
        if (!me) return fail("no-token");
        const p = body.photo ?? {}, id = str(p.id, 48);
        if (!ID.test(id)) return fail("bad-id");
        const row = { id, full_path: `${id}.jpg`, thumb_path: `${id}_t.jpg`, taken_at: new Date(p.taken_at).toISOString(),
          time_src: str(p.time_src, 10), place: str(p.place, 100), caption: str(p.caption, 300), name: str(p.name, 120),
          decorated: !!p.decorated, from_id: p.from_id ? str(p.from_id, 48) : null, owner_hash: me };
        const { error } = await sb.from("photos").insert(row);
        if (error && error.code !== "23505") return fail("db");
        const urls = await sign([row.full_path, row.thumb_path]);
        return out({ ok: true, photo: photoOut(row, urls, me) });
      }

      case "update_photo":
      case "delete_photo": {
        const id = str(body.id, 48);
        const { data: row } = await sb.from("photos").select("*").eq("id", id).maybeSingle();
        if (!row) return fail("not-found");
        if (body.action === "delete_photo") {
          await sb.from("photos").delete().eq("id", id);
          await sb.storage.from(BUCKET).remove([row.full_path, row.thumb_path]);
          return out({ ok: true });
        }
        const p = body.photo ?? {};
        const upd = { place: str(p.place, 100), caption: str(p.caption, 300), taken_at: new Date(p.taken_at).toISOString(), time_src: str(p.time_src, 10) };
        const { error } = await sb.from("photos").update(upd).eq("id", id);
        return error ? fail("db") : out({ ok: true });
      }

      case "eta":
        return out({ ok: true, ...(await eta(body.legs)) });

      default:
        return fail("bad-action");
    }
  } catch (e) {
    console.error(String(e));
    return fail("server");
  }
});
