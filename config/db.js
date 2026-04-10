import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { createClient } from "@supabase/supabase-js";

console.log("DB ENV:", process.env.SUPABASE_URL); // debug

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

export default supabase;