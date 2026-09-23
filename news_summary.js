export async function readNewsSummaryFile(fsModule, filepath, safeName) {
  try {
    const content = await fsModule.readFile(filepath, 'utf-8');
    return { found: true, content };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { found: false, result: { status: 'not_found', category: 'news_summary', filename: safeName } };
    }
    throw error;
  }
}
