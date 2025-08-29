// File: src/lib/upload.js
import { supabase } from "../supabaseClient";

const PUBLIC_BUCKET = "agent-public";
const PRIVATE_BUCKET = "agent-private";

export async function uploadPublicImage(userId, file, prefix = "headshots") {
  const ext = file.name.split(".").pop().toLowerCase();
  const path = `${prefix}/${userId}-${Date.now()}.${ext}`;
  const { error } = await supabase.storage.from(PUBLIC_BUCKET).upload(path, file, {
    cacheControl: "3600",
    upsert: true,
  });
  if (error) throw error;

  const { data } = supabase.storage.from(PUBLIC_BUCKET).getPublicUrl(path);
  return { storagePath: path, publicUrl: data.publicUrl };
}

export async function uploadPrivateDoc(userId, file, type = "license") {
  const ext = file.name.split(".").pop().toLowerCase();
  const path = `docs/${type}/${userId}-${Date.now()}.${ext}`;
  const { error } = await supabase.storage.from(PRIVATE_BUCKET).upload(path, file, { upsert: true });
  if (error) throw error;
  return path;
}
