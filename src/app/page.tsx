import { currentActor, demoEnabled, store } from "@/lib/server/service";
import { Workspace } from "@/components/workspace";
import { SignIn } from "@/components/sign-in";
import { CalendarClockProvider } from "@/components/calendar-clock";

export const dynamic = "force-dynamic";
export default async function Page() {
  const configured =
    demoEnabled() ||
    !!(
      process.env.NEXT_PUBLIC_SUPABASE_URL &&
      (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
        process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY)
    );
  if (!configured) return <SignIn setup />;
  let state;
  try {
    const actor = await currentActor();
    state = await store.getState(actor.id);
  } catch {
    return <SignIn />;
  }
  return <CalendarClockProvider initialNow={new Date().toISOString()}><Workspace initialState={state} /></CalendarClockProvider>;
}
