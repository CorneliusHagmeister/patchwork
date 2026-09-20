import { json } from "@/lib/api";
import { getState } from "@/lib/store";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return json(await getState());
}
