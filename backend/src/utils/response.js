export const success = (res, data = null, message = 'Success', statusCode = 200) => {
  return res.status(statusCode).json({ success: true, message, data });
};

export const created = (res, data, message = 'Created') => {
  return success(res, data, message, 201);
};

export const error = (res, message = 'Error', statusCode = 500) => {
  return res.status(statusCode).json({ success: false, message });
};
