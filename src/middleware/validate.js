function validate(schema, source = 'body') {
  return (req, res, next) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      const message = result.error.issues
        .map(i => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      return res.status(400).json({ error: message || 'Invalid input' });
    }
    req[source] = result.data;
    next();
  };
}
module.exports = { validate };
