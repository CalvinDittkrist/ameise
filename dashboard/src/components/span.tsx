import { age, until } from "@/api"
import { useNow } from "@/hooks/use-now"

// Age is the time since an instant, which advances while the page stays open.
export const Age = ({ since }: { since: string | null }) => <>{useNow((now) => age(since, now))}</>

// Until is the time to an instant, which counts down while the page stays open.
export const Until = ({ at }: { at: string }) => <>{useNow((now) => until(at, now))}</>
