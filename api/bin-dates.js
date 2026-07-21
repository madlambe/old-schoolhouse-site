export default {
  async fetch() {
    return Response.json({
      ok: true,
      diagnostic: true,
      message: "The bin-dates Vercel function is loading correctly.",
      checkedAt: new Date().toISOString()
    });
  }
};
