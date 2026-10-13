import { render, screen } from '@testing-library/react';
import App from './App';

beforeEach(() => {
  global.fetch = jest.fn(() => Promise.resolve({ json: () => Promise.resolve([]) }));
});

test('mostra il pannello del copilot', () => {
  render(<App />);
  expect(screen.getByText('Cosa facciamo al mix?')).toBeInTheDocument();
});
