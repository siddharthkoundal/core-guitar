import { render as renderComponent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';

export { screen, fireEvent, waitFor, cleanup, renderHook, act } from '@testing-library/react';
export function render(component: ReactElement) {
  return { ...renderComponent(component), userEvent: userEvent.setup() };
}
